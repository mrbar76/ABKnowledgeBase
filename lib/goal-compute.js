// Goals tracking — compute helpers for status, projection, and value derivation
// from workout data. Pure-function module for testability; SQL stays in
// routes/goals.js. The recomputeGoal(goal, query) hook reads workouts via the
// passed query function so it works inside transactions or against test
// fixtures.

// ─── Status computation ───────────────────────────────────────────
// Spec section 4 step 4 — band thresholds:
//   ahead     : actual > expected + 10%   (only if not yet complete)
//   on_track  : within ±10% of expected
//   behind    : 10–25% under expected
//   at_risk   : >25% under expected
//   complete  : actual >= target (regardless of expected)
// Pace metrics (lower = better) flip the comparison.

function isPaceMetric(metric) {
  return metric === 'pace_min_per_mi';
}

function computeStatus(goal) {
  if (goal.status === 'paused' || goal.status === 'failed') return goal.status;
  // v1.11.2: no data → pending. Was returning 'on_track' default which
  // looked like a positive signal when there was actually no signal at all.
  if (goal.current_value == null) return 'pending';

  const target = Number(goal.target_value);
  const anchor = Number(goal.anchor_value);
  const current = Number(goal.current_value);
  const pace = isPaceMetric(goal.metric);

  // Complete check first — direction-aware
  if (pace) {
    if (current <= target) return 'complete';
  } else {
    if (current >= target) return 'complete';
  }

  const today = new Date();
  const anchorDate = new Date(goal.anchor_date);
  const targetDate = new Date(goal.target_date);
  const totalMs = targetDate.getTime() - anchorDate.getTime();
  const elapsedMs = today.getTime() - anchorDate.getTime();

  // No time elapsed yet, or target date already past with no completion
  if (totalMs <= 0) return current >= target ? 'complete' : 'failed';
  const fracElapsed = Math.max(0, Math.min(1, elapsedMs / totalMs));
  const expected = anchor + (target - anchor) * fracElapsed;

  // Distance from expected, normalized by the total expected delta
  const totalDelta = target - anchor;
  if (totalDelta === 0) return current === target ? 'complete' : 'on_track';

  // For pace metrics (target < anchor), "actual better than expected" means
  // lower current. Flip the deviation sign by passing -totalDelta semantics.
  // Easiest: compute fractional progress vs expected progress.
  const actualProgressFrac = (current - anchor) / totalDelta; // 0=at anchor, 1=at target
  const expectedProgressFrac = fracElapsed;
  const deviationFrac = actualProgressFrac - expectedProgressFrac;
  // For pace (target < anchor): totalDelta is negative; (current - anchor)
  // for an improving pace is also negative. So (negative / negative) = positive.
  // The semantics work without flipping.

  if (deviationFrac > 0.10) return 'ahead';
  if (deviationFrac >= -0.10) return 'on_track';
  if (deviationFrac >= -0.25) return 'behind';
  return 'at_risk';
}

// ─── Trajectory projection ────────────────────────────────────────
// Least-squares slope on last N history points (or all if fewer).
// Returns {slope, intercept, projected_target_date | null}.
function projectCompletion(historyPoints, target, anchorDate, targetMetric) {
  const pts = (historyPoints || []).slice(-4); // spec: last 4
  if (pts.length < 2) return { slope: null, projected_target_date: null };

  const anchorMs = new Date(anchorDate).getTime();
  // x = days since anchor, y = value
  const xs = pts.map(p => (new Date(p.recorded_at).getTime() - anchorMs) / 86400_000);
  const ys = pts.map(p => Number(p.value));
  const n = xs.length;
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return { slope: null, projected_target_date: null };
  const slope = num / den; // value per day
  const intercept = yMean - slope * xMean;

  // For pace (target < anchor) slope should be negative to project completion.
  // For everything else slope should be positive.
  const pace = isPaceMetric(targetMetric);
  const goingRightDirection = pace ? slope < 0 : slope > 0;
  if (!goingRightDirection || slope === 0) {
    return { slope, intercept, projected_target_date: null };
  }

  // Solve: target = intercept + slope * x  =>  x = (target - intercept) / slope
  const targetX = (Number(target) - intercept) / slope;
  if (!Number.isFinite(targetX) || targetX < 0) {
    return { slope, intercept, projected_target_date: null };
  }
  const projDate = new Date(anchorMs + targetX * 86400_000);
  return {
    slope,
    intercept,
    projected_target_date: projDate.toISOString().slice(0, 10),
  };
}

// ─── Per-workout compute drivers ──────────────────────────────────
// Each method takes the goal + a list of workouts, returns the new
// current_value + the workout that produced it (for current_value_source_id).

function maxWeightFromWorkouts(goal, workouts) {
  // Filter to linked exercise names (case-insensitive). For each matching set,
  // find the heaviest weight_lbs. If goal title mentions a rep floor (e.g.,
  // "225x5"), filter sets where reps >= that floor.
  const repFloor = parseRepFloor(goal);
  let bestWeight = null;
  let bestWorkout = null;
  for (const w of workouts) {
    const exercises = parseExercisesField(w.exercises);
    for (const ex of exercises) {
      if (!matchesLinkedExercise(ex.name, goal.linked_exercise_names)) continue;
      for (const set of (ex.sets || [])) {
        const weight = Number(set.weight_lbs ?? set.weight_lb ?? set.weight);
        const reps = Number(set.reps);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        if (repFloor != null && (!Number.isFinite(reps) || reps < repFloor)) continue;
        if (bestWeight == null || weight > bestWeight) {
          bestWeight = weight;
          bestWorkout = w;
        }
      }
    }
  }
  return { value: bestWeight, source_workout: bestWorkout };
}

function maxRepsSingleSetFromWorkouts(goal, workouts) {
  let bestReps = null;
  let bestWorkout = null;
  for (const w of workouts) {
    const exercises = parseExercisesField(w.exercises);
    for (const ex of exercises) {
      if (!matchesLinkedExercise(ex.name, goal.linked_exercise_names)) continue;
      for (const set of (ex.sets || [])) {
        // Skip warmup sets if flagged
        if (set.warmup === true || set.set_type === 'warmup') continue;
        const reps = Number(set.reps);
        if (!Number.isFinite(reps) || reps <= 0) continue;
        if (bestReps == null || reps > bestReps) {
          bestReps = reps;
          bestWorkout = w;
        }
      }
    }
  }
  return { value: bestReps, source_workout: bestWorkout };
}

function latestPaceFromWorkouts(goal, workouts) {
  // Pace = duration_minutes / distance_value (min/mi). Apply distance floor
  // from the goal title (e.g., "5mi @ 9:30/mi" → distance >= 5).
  const distanceFloor = parseDistanceFloor(goal);
  let latest = null;
  let latestDate = null;
  let latestWorkout = null;
  for (const w of workouts) {
    const wt = (w.workout_type || '').toLowerCase();
    if (goal.linked_workout_types && goal.linked_workout_types.length
        && !goal.linked_workout_types.map(t => t.toLowerCase()).includes(wt)) continue;
    const dist = Number(w.distance_value);
    const dur = Number(w.duration_minutes);
    if (!Number.isFinite(dist) || dist <= 0) continue;
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (distanceFloor != null && dist < distanceFloor) continue;
    const pace = dur / dist;
    const dateMs = new Date(w.workout_date || w.created_at).getTime();
    if (latestDate == null || dateMs > latestDate) {
      latestDate = dateMs;
      latest = pace;
      latestWorkout = w;
    }
  }
  return { value: latest != null ? Math.round(latest * 100) / 100 : null, source_workout: latestWorkout };
}

function maxDurationFromWorkouts(goal, workouts) {
  let bestDur = null;
  let bestWorkout = null;
  for (const w of workouts) {
    const wt = (w.workout_type || '').toLowerCase();
    const matchesType = goal.linked_workout_types && goal.linked_workout_types.length
      && goal.linked_workout_types.map(t => t.toLowerCase()).includes(wt);
    const exercises = parseExercisesField(w.exercises);
    const matchesExercise = exercises.some(ex => matchesLinkedExercise(ex.name, goal.linked_exercise_names));
    if (!matchesType && !matchesExercise) continue;
    const dur = Number(w.duration_minutes);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (bestDur == null || dur > bestDur) {
      bestDur = dur;
      bestWorkout = w;
    }
  }
  return { value: bestDur, source_workout: bestWorkout };
}

function totalVolumeFromWorkouts(goal, workouts) {
  // Last 7 days of (weight * reps) summed across linked exercises
  const cutoff = Date.now() - 7 * 86400_000;
  let total = 0;
  let lastWorkout = null;
  for (const w of workouts) {
    const dateMs = new Date(w.workout_date || w.created_at).getTime();
    if (dateMs < cutoff) continue;
    const exercises = parseExercisesField(w.exercises);
    for (const ex of exercises) {
      if (!matchesLinkedExercise(ex.name, goal.linked_exercise_names)) continue;
      for (const set of (ex.sets || [])) {
        const weight = Number(set.weight_lbs ?? set.weight_lb ?? set.weight) || 0;
        const reps = Number(set.reps) || 0;
        total += weight * reps;
      }
    }
    if (!lastWorkout || dateMs > new Date(lastWorkout.workout_date || lastWorkout.created_at).getTime()) {
      lastWorkout = w;
    }
  }
  return { value: total > 0 ? Math.round(total) : null, source_workout: lastWorkout };
}

// ─── Helpers ──────────────────────────────────────────────────────
function matchesLinkedExercise(exerciseName, linked) {
  if (!exerciseName || !linked || !linked.length) return false;
  const lower = String(exerciseName).toLowerCase().trim();
  return linked.some(name => String(name).toLowerCase().trim() === lower);
}

function parseExercisesField(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  if (typeof field === 'string') {
    try { return JSON.parse(field); } catch (_) { return []; }
  }
  return [];
}

// "225×5" → 5; "8 strict" → null; "Run 5mi" → null
function parseRepFloor(goal) {
  const t = goal.title || '';
  const m = t.match(/(\d+)\s*[x×]\s*(\d+)/i);
  return m ? Number(m[2]) : null;
}

// "5mi @ 9:30/mi" → 5; "Run 5 mi" → 5
function parseDistanceFloor(goal) {
  const t = goal.title || '';
  const m = t.match(/(\d+(?:\.\d+)?)\s*mi/i);
  return m ? Number(m[1]) : null;
}

const DRIVERS = {
  max_weight: maxWeightFromWorkouts,
  max_reps_single_set: maxRepsSingleSetFromWorkouts,
  latest_pace: latestPaceFromWorkouts,
  max_duration: maxDurationFromWorkouts,
  total_volume: totalVolumeFromWorkouts,
};

function computeValueForGoal(goal, workouts) {
  if (goal.compute_method === 'manual') return { value: null, source_workout: null };
  const driver = DRIVERS[goal.compute_method];
  if (!driver) return { value: null, source_workout: null };
  return driver(goal, workouts);
}

module.exports = {
  computeStatus,
  projectCompletion,
  computeValueForGoal,
  isPaceMetric,
  parseRepFloor,
  parseDistanceFloor,
  matchesLinkedExercise,
  parseExercisesField,
  // exposed for tests
  _drivers: DRIVERS,
};
