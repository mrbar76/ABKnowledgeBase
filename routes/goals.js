// Goals tracking — CRUD + dashboard + status + trajectory + phase management.
//
// Spec: knowledge entry 1f247878. Phases A+B+C build, v1.11.0.
// - Phase A: tables, CRUD, manual updates, dashboard.
// - Phase B: auto-compute hooks (recomputeForWorkout) + status + trajectory.
// - Phase C: home-view UI cards + trajectory chart (lives in public/app.js).

const express = require('express');
const { query, logActivity } = require('../db');
const {
  computeStatus,
  projectCompletion,
  computeValueForGoal,
} = require('../lib/goal-compute');

const router = express.Router();

// ─── helpers ──────────────────────────────────────────────────────
// v1.11.8 Fix 5: Coach's preferred sort order — actionability priority.
// at_risk (immediate concern) → behind (catching up) → on_track (steady) →
// pending (needs first data point) → ahead (light push) → paused / complete /
// failed at bottom. Was: pending floated above on_track which buried
// in-progress goals.
const STATUS_URGENCY = {
  at_risk: 0, behind: 1, on_track: 2, pending: 3, ahead: 4, paused: 5, complete: 6, failed: 7,
};

function dateOnly(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400_000);
}

function activePhaseForDate(phases, date) {
  const d = new Date(date).getTime();
  return phases.find(p =>
    new Date(p.start_date).getTime() <= d && d <= new Date(p.end_date).getTime()
  ) || null;
}

function lastUpdateLabel(goal) {
  if (!goal.current_value_date) return 'no data yet';
  const days = daysBetween(goal.current_value_date, Date.now());
  if (days <= 0) return `updated today: ${goal.current_value}`;
  if (days === 1) return `updated yesterday: ${goal.current_value}`;
  return `${days}d ago: ${goal.current_value}`;
}

// ─── GET /api/goals ───────────────────────────────────────────────
// List active + paused goals (not failed/complete unless ?include=all).
router.get('/', async (req, res) => {
  try {
    const include = (req.query.include || 'active').toLowerCase();
    let where = "WHERE status NOT IN ('failed')";
    if (include === 'all') where = '';
    else if (include === 'active') where = "WHERE status NOT IN ('complete','failed')";
    else if (include === 'complete') where = "WHERE status = 'complete'";
    const r = await query(`SELECT * FROM goals ${where} ORDER BY target_date ASC`);
    res.json({ count: r.rows.length, goals: r.rows });
  } catch (err) {
    console.error('[GET /goals]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/goals/dashboard ─────────────────────────────────────
// One-shot composite for the home view + Coach. v1.11.8 additions:
//   - last_attempt per goal: latest workout matching linked_exercise_names
//     (even when its data didn't advance current_value, e.g. sub-anchor
//     re-entry sessions). Lets the UI surface "last attempt: 60lb / 20m"
//     under the trio.
//   - is_at_baseline: true when current_value == anchor_value (day-zero).
//     UI uses this to render a "Baseline set" marker instead of empty
//     progress bar.
//   - next_phase_label: when active_phase is null (between phases), the
//     human-readable label for the next phase that will start.
router.get('/dashboard', async (req, res) => {
  try {
    const today = dateOnly(new Date());
    const [goalsR, phasesR] = await Promise.all([
      query(`SELECT * FROM goals WHERE status NOT IN ('failed') ORDER BY target_date ASC`),
      query(`SELECT * FROM goal_phases ORDER BY phase_number ASC`),
    ]);

    const activePhase = activePhaseForDate(phasesR.rows, today);
    const phaseTag = activePhase ? `phase_${activePhase.phase_number}` : null;

    // Find the NEXT phase that hasn't started yet — used in the header
    // when active_phase is null (between phases).
    const nextPhase = !activePhase
      ? phasesR.rows.find(p => dateOnly(p.start_date) > today) || null
      : null;

    // Status urgency desc, then deadline asc within same status. Spec section 6.
    const sortGoals = (goals) => goals.sort((a, b) => {
      const sa = STATUS_URGENCY[a.status] ?? 99;
      const sb = STATUS_URGENCY[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return new Date(a.target_date).getTime() - new Date(b.target_date).getTime();
    });

    const goalsActive = sortGoals(goalsR.rows.filter(g => g.status !== 'complete'));
    const goalsComplete = goalsR.rows.filter(g => g.status === 'complete')
      .sort((a, b) => new Date(b.current_value_date || 0).getTime() - new Date(a.current_value_date || 0).getTime());

    // Per-goal computed surface for the UI. v1.11.8: client-side timezone
    // rendering for last_update_label (date strings are sent raw; client
    // computes "today / yesterday / N days ago" in user's local TZ).
    // is_at_baseline: true when current_value == anchor_value.
    const decorate = (g) => {
      const days_left = daysBetween(today, g.target_date);
      const expected = (() => {
        const totalDays = daysBetween(g.anchor_date, g.target_date);
        if (totalDays <= 0) return null;
        const elapsed = Math.max(0, daysBetween(g.anchor_date, today));
        const frac = Math.min(1, elapsed / totalDays);
        return Number(g.anchor_value) + (Number(g.target_value) - Number(g.anchor_value)) * frac;
      })();
      const isPrimary = phaseTag && Array.isArray(g.phase_primary) && g.phase_primary.includes(phaseTag);
      const isMaintenance = phaseTag && Array.isArray(g.phase_maintenance) && g.phase_maintenance.includes(phaseTag);
      const isAtBaseline = g.current_value != null
        && Number(g.current_value) === Number(g.anchor_value);
      return {
        ...g,
        days_left,
        expected_today: expected != null ? Math.round(expected * 100) / 100 : null,
        // Send raw date string; client renders relative label in local TZ.
        // last_update_label kept for backwards compat but client should
        // prefer current_value_date_iso going forward.
        last_update_label: lastUpdateLabel(g),
        current_value_date_iso: g.current_value_date ? dateOnly(g.current_value_date) : null,
        is_at_baseline: isAtBaseline,
        active_phase_role: isPrimary ? 'primary' : (isMaintenance ? 'maintenance' : 'inactive'),
      };
    };

    // v1.11.8 Fix 4: last_attempt per goal — latest workout matching
    // linked_exercise_names OR linked_workout_types since anchor_date,
    // even if it didn't advance current_value. Surfaces sub-anchor
    // re-entry sessions Coach deliberately doesn't patch.
    async function lastAttemptFor(g) {
      try {
        const names = (g.linked_exercise_names || []).map(n => String(n).toLowerCase());
        const types = (g.linked_workout_types || []).map(t => String(t).toLowerCase());
        if (!names.length && !types.length) return null;

        // Match either by workout_type OR by any exercise name in the
        // exercises JSONB array (case-insensitive).
        const r = await query(
          `SELECT id, title, workout_date, workout_type, effort,
                  duration_minutes, distance_value, exercises
             FROM workouts
            WHERE deleted_at IS NULL
              AND workout_date >= $1
              AND (
                LOWER(workout_type) = ANY($2)
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(exercises) = 'array' THEN exercises ELSE '[]'::jsonb END
                  ) ex
                  WHERE LOWER(ex->>'name') = ANY($3)
                )
              )
            ORDER BY workout_date DESC, started_at DESC NULLS LAST, created_at DESC
            LIMIT 1`,
          [g.anchor_date, types, names]
        );
        if (!r.rows.length) return null;
        const w = r.rows[0];
        // Pull a key metric depending on the goal type for display
        let metric_label = null;
        if (g.metric === 'reps' || g.metric === 'weight_lb') {
          // strength — pluck top set from matching exercise
          try {
            const ex = typeof w.exercises === 'string' ? JSON.parse(w.exercises) : (w.exercises || []);
            const matching = ex.find(e => names.includes(String(e.name || '').toLowerCase()));
            if (matching && Array.isArray(matching.sets) && matching.sets.length) {
              const topSet = matching.sets.reduce((best, s) => {
                const w_ = Number(s.weight_lbs ?? s.weight_lb ?? s.weight) || 0;
                const r_ = Number(s.reps) || 0;
                const score = (w_ * r_) || r_;
                return score > (best._score || 0) ? { ...s, _score: score } : best;
              }, {});
              if (topSet.weight_lbs || topSet.weight_lb || topSet.weight) {
                metric_label = `${topSet.weight_lbs ?? topSet.weight_lb ?? topSet.weight}lb × ${topSet.reps || '?'}`;
              } else if (topSet.reps) {
                metric_label = `${topSet.reps} reps`;
              }
            }
          } catch (_) { /* fall through with null metric_label */ }
        } else if (g.metric === 'duration_min') {
          metric_label = w.duration_minutes ? `${w.duration_minutes}m` : null;
        } else if (g.metric === 'pace_min_per_mi') {
          if (w.duration_minutes && w.distance_value) {
            const pace = Number(w.duration_minutes) / Number(w.distance_value);
            metric_label = `${(Math.round(pace * 100) / 100)}/mi @ ${w.distance_value}mi`;
          }
        }
        return {
          workout_id: w.id,
          title: w.title,
          date: dateOnly(w.workout_date),
          metric_label,
          // is_sub_anchor: true if the value didn't advance current_value
          is_sub_anchor: g.current_value_date && dateOnly(w.workout_date) > dateOnly(g.current_value_date)
            ? false  // newer than current_value_date — wait, we'd expect it to advance then
            : true,  // older or no current_value yet — likely a sub-anchor session
        };
      } catch (err) {
        console.error('[lastAttemptFor]', err.message);
        return null;
      }
    }

    // Decorate + attach last_attempt in parallel
    const decoratedActive = await Promise.all(goalsActive.map(async g => {
      const decorated = decorate(g);
      decorated.last_attempt = await lastAttemptFor(g);
      return decorated;
    }));
    const primaryTitles = decoratedActive.filter(g => g.active_phase_role === 'primary').map(g => g.title);
    const maintenanceTitles = decoratedActive.filter(g => g.active_phase_role === 'maintenance').map(g => g.title);

    // v1.11.8 Fix 6: better between-phases header. When active_phase is
    // null and a next_phase exists, surface the lead-in countdown.
    let focusSummary;
    if (activePhase) {
      focusSummary = `Phase ${activePhase.phase_number}: ${activePhase.phase_name}. ` +
        `Primary: ${primaryTitles.join(', ') || '—'}. Maintenance: ${maintenanceTitles.join(', ') || '—'}.`;
    } else if (nextPhase) {
      const daysToNext = daysBetween(today, nextPhase.start_date);
      focusSummary = `Between phases. Phase ${nextPhase.phase_number} (${nextPhase.phase_name}) starts in ${daysToNext} day${daysToNext === 1 ? '' : 's'} on ${dateOnly(nextPhase.start_date)}.`;
    } else {
      focusSummary = 'No active or upcoming phase scheduled.';
    }

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      active_phase: activePhase,
      next_phase: nextPhase,  // v1.11.8: surface for UI between-phases header
      goals_active: decoratedActive,
      goals_complete: goalsComplete.map(decorate),
      focus_summary: focusSummary,
    });
  } catch (err) {
    console.error('[GET /goals/dashboard]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/goals/phases/current ────────────────────────────────
router.get('/phases/current', async (req, res) => {
  try {
    const today = dateOnly(new Date());
    const r = await query(
      `SELECT * FROM goal_phases
       WHERE start_date <= $1 AND end_date >= $1
       ORDER BY phase_number ASC LIMIT 1`,
      [today]
    );
    res.json({ phase: r.rows[0] || null, date: today });
  } catch (err) {
    console.error('[GET /goals/phases/current]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

router.get('/phases', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM goal_phases ORDER BY phase_number ASC`);
    res.json({ count: r.rows.length, phases: r.rows });
  } catch (err) {
    console.error('[GET /goals/phases]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

router.post('/phases', async (req, res) => {
  try {
    const b = req.body;
    if (!b.phase_number || !b.phase_name || !b.start_date || !b.end_date) {
      return res.status(400).json({ error: 'phase_number, phase_name, start_date, end_date required' });
    }
    const r = await query(
      `INSERT INTO goal_phases (phase_number, phase_name, start_date, end_date, description, linked_race_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.phase_number, b.phase_name, b.start_date, b.end_date, b.description || null, b.linked_race_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[POST /goals/phases]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/goals/:id ───────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const goal = await query(`SELECT * FROM goals WHERE id = $1`, [req.params.id]);
    if (!goal.rows.length) return res.status(404).json({ error: 'Goal not found' });
    const history = await query(
      `SELECT * FROM goal_history WHERE goal_id = $1 ORDER BY recorded_at ASC`,
      [req.params.id]
    );
    res.json({ ...goal.rows[0], history: history.rows });
  } catch (err) {
    console.error('[GET /goals/:id]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/goals ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const required = ['title','category','metric','anchor_value','anchor_date','target_value','target_date','compute_method'];
    const missing = required.filter(f => b[f] == null || b[f] === '');
    if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });

    const r = await query(
      `INSERT INTO goals (
         title, category, metric, anchor_value, anchor_date, anchor_source,
         target_value, target_date, current_value, current_value_date,
         linked_exercise_names, linked_workout_types, compute_method,
         phase_primary, phase_maintenance, status, evidence_label, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        b.title, b.category, b.metric,
        b.anchor_value, b.anchor_date, b.anchor_source || null,
        b.target_value, b.target_date,
        b.current_value ?? b.anchor_value,
        b.current_value_date || b.anchor_date,
        b.linked_exercise_names || [],
        b.linked_workout_types || [],
        b.compute_method,
        b.phase_primary || [], b.phase_maintenance || [],
        b.status || 'on_track',
        b.evidence_label || null,
        b.notes || null,
      ]
    );
    const goal = r.rows[0];
    // Seed first history point with the anchor so trajectory has a baseline
    await query(
      `INSERT INTO goal_history (goal_id, value, recorded_at, source_note)
       VALUES ($1, $2, $3, $4)`,
      [goal.id, goal.anchor_value, goal.anchor_date, 'anchor']
    );
    await logActivity('create', 'goal', goal.id, b.ai_source || 'manual', `Goal: ${b.title}`);
    res.status(201).json(goal);
  } catch (err) {
    console.error('[POST /goals]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/goals/:id ───────────────────────────────────────────
// Coach uses this for: anchor recalibration (with reason), target_date
// changes, current_value manual update (compute_method='manual'),
// status changes (paused/resumed).
router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const allowed = [
      'title','category','metric','anchor_value','anchor_date','anchor_source',
      'target_value','target_date','current_value','current_value_date',
      'current_value_source_id','linked_exercise_names','linked_workout_types',
      'compute_method','phase_primary','phase_maintenance','status',
      'evidence_label','notes',
    ];
    const fields = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(b[k]);
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const r = await query(
      `UPDATE goals SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Goal not found' });

    // If current_value was manually set, append to history. Coach's primary
    // path for `manual` compute_method goals.
    if (b.current_value !== undefined) {
      await query(
        `INSERT INTO goal_history (goal_id, value, source_workout_id, source_note)
         VALUES ($1, $2, $3, $4)`,
        [
          req.params.id,
          b.current_value,
          b.current_value_source_id || null,
          b.source_note || 'manual update',
        ]
      );
    }

    // Recompute status now that values may have changed
    const updated = r.rows[0];
    const newStatus = computeStatus(updated);
    if (newStatus !== updated.status && b.status === undefined) {
      await query(`UPDATE goals SET status = $1, updated_at = NOW() WHERE id = $2`, [newStatus, req.params.id]);
      updated.status = newStatus;
    }

    await logActivity('update', 'goal', req.params.id, b.ai_source || 'manual', `Goal updated: ${updated.title}`);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /goals/:id]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/goals/:id ────────────────────────────────────────
// Soft delete — set status=paused. Hard delete supported via ?hard=true.
router.delete('/:id', async (req, res) => {
  try {
    if (req.query.hard === 'true') {
      await query(`DELETE FROM goals WHERE id = $1`, [req.params.id]);
      return res.json({ deleted: true, hard: true });
    }
    const r = await query(
      `UPDATE goals SET status = 'paused', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Goal not found' });
    res.json({ deleted: true, soft: true, goal: r.rows[0] });
  } catch (err) {
    console.error('[DELETE /goals/:id]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/goals/:id/status ────────────────────────────────────
// Recompute current_value from workouts NOW + return the status.
router.get('/:id/status', async (req, res) => {
  try {
    const goal = await query(`SELECT * FROM goals WHERE id = $1`, [req.params.id]);
    if (!goal.rows.length) return res.status(404).json({ error: 'Goal not found' });
    const updated = await recomputeOneGoal(goal.rows[0]);
    res.json(updated);
  } catch (err) {
    console.error('[GET /goals/:id/status]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/goals/:id/trajectory ────────────────────────────────
router.get('/:id/trajectory', async (req, res) => {
  try {
    const goal = await query(`SELECT * FROM goals WHERE id = $1`, [req.params.id]);
    if (!goal.rows.length) return res.status(404).json({ error: 'Goal not found' });
    const history = await query(
      `SELECT * FROM goal_history WHERE goal_id = $1 ORDER BY recorded_at ASC`,
      [req.params.id]
    );
    const projection = projectCompletion(history.rows, goal.rows[0].target_value, goal.rows[0].anchor_date, goal.rows[0].metric);
    res.json({
      goal: goal.rows[0],
      history: history.rows,
      projection,
    });
  } catch (err) {
    console.error('[GET /goals/:id/trajectory]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/goals/recompute-all ────────────────────────────────
// Called from POST /workouts and Hevy sync. Also exposed manually.
router.post('/recompute-all', async (req, res) => {
  try {
    const result = await recomputeAllGoals();
    res.json(result);
  } catch (err) {
    console.error('[POST /goals/recompute-all]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── recompute internals (also exported for hooks) ────────────────
async function recomputeOneGoal(goal) {
  if (goal.compute_method === 'manual') {
    // Manual goals: just recompute status from existing current_value
    const newStatus = computeStatus(goal);
    if (newStatus !== goal.status) {
      await query(`UPDATE goals SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, goal.id]);
      goal.status = newStatus;
    }
    return goal;
  }

  // Pull workouts since the anchor date
  const workouts = await query(
    `SELECT id, title, workout_date, workout_type, duration_minutes,
            distance_value, exercises, created_at
     FROM workouts
     WHERE workout_date >= $1 AND deleted_at IS NULL
     ORDER BY workout_date ASC`,
    [goal.anchor_date]
  );

  const { value, source_workout } = computeValueForGoal(goal, workouts.rows);
  if (value == null) {
    // No data yet; just refresh status (might transition from on_track to at_risk over time)
    const newStatus = computeStatus(goal);
    if (newStatus !== goal.status) {
      await query(`UPDATE goals SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, goal.id]);
      goal.status = newStatus;
    }
    return goal;
  }

  // Direction-aware "is this a new best?"
  // For pace metrics: lower = better. For everything else: higher = better.
  const isPace = goal.metric === 'pace_min_per_mi';
  const current = goal.current_value != null ? Number(goal.current_value) : null;
  const isNewBest = current == null
    || (isPace ? value < current : value > current);

  if (!isNewBest) {
    const newStatus = computeStatus(goal);
    if (newStatus !== goal.status) {
      await query(`UPDATE goals SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, goal.id]);
      goal.status = newStatus;
    }
    return goal;
  }

  const sourceDate = source_workout?.workout_date || new Date().toISOString().slice(0, 10);
  const sourceId = source_workout?.id || null;
  const note = source_workout
    ? `Workout ${source_workout.title || source_workout.id} on ${dateOnly(source_workout.workout_date)}`
    : 'auto-compute';

  // Update goal + append history in one transaction-ish sequence
  await query(
    `UPDATE goals SET
       current_value = $1, current_value_date = $2, current_value_source_id = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [value, sourceDate, sourceId, goal.id]
  );
  await query(
    `INSERT INTO goal_history (goal_id, value, source_workout_id, source_note)
     VALUES ($1, $2, $3, $4)`,
    [goal.id, value, sourceId, note]
  );

  goal.current_value = value;
  goal.current_value_date = sourceDate;
  goal.current_value_source_id = sourceId;
  goal.status = computeStatus(goal);
  await query(`UPDATE goals SET status = $1 WHERE id = $2`, [goal.status, goal.id]);

  return goal;
}

async function recomputeAllGoals() {
  const goals = await query(
    `SELECT * FROM goals WHERE status NOT IN ('complete','failed')`
  );
  const updated = [];
  for (const g of goals.rows) {
    try {
      const result = await recomputeOneGoal(g);
      updated.push({ id: result.id, title: result.title, status: result.status, current_value: result.current_value });
    } catch (err) {
      console.error(`[goals recompute] ${g.id} failed: ${err.message}`);
      updated.push({ id: g.id, title: g.title, error: err.message });
    }
  }
  return { recomputed_count: updated.length, goals: updated };
}

// Hook called from POST /workouts after a new workout lands.
// Filters to goals whose linked_exercise_names or linked_workout_types
// match the workout, recomputes only those.
async function recomputeForWorkout(workoutRow) {
  if (!workoutRow) return { recomputed_count: 0 };
  const exerciseNames = (() => {
    try {
      const ex = typeof workoutRow.exercises === 'string'
        ? JSON.parse(workoutRow.exercises) : (workoutRow.exercises || []);
      return ex.map(e => String(e.name || '').toLowerCase().trim()).filter(Boolean);
    } catch (_) { return []; }
  })();
  const workoutType = (workoutRow.workout_type || '').toLowerCase();

  const goals = await query(
    `SELECT * FROM goals
     WHERE status NOT IN ('complete','failed','paused')
       AND compute_method <> 'manual'`
  );
  const matching = goals.rows.filter(g => {
    const namesOverlap = (g.linked_exercise_names || []).some(n =>
      exerciseNames.includes(String(n).toLowerCase().trim())
    );
    const typeMatch = (g.linked_workout_types || []).some(t =>
      String(t).toLowerCase() === workoutType
    );
    return namesOverlap || typeMatch;
  });

  const updated = [];
  for (const g of matching) {
    try {
      const r = await recomputeOneGoal(g);
      updated.push({ id: r.id, title: r.title, status: r.status, current_value: r.current_value });
    } catch (err) {
      console.error(`[goals recompute-for-workout] ${g.id} failed: ${err.message}`);
    }
  }
  return { recomputed_count: updated.length, goals: updated };
}

// ─── Phase auto-advance check ─────────────────────────────────────
// Called once at server boot + once per day from the existing notification
// scheduler. When today is a phase's start_date, write a single activity log
// entry "Phase X started" so it surfaces in the activity stream UI. Push
// notification piggybacks on the existing gamification subscription if
// available; otherwise the activity log entry is the user-visible signal.
async function checkPhaseAdvance() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await query(
      `SELECT * FROM goal_phases WHERE start_date = $1`,
      [today]
    );
    if (!r.rows.length) return { advanced: 0 };
    for (const phase of r.rows) {
      // Idempotency: only log once per phase start. Check activity_log for
      // a same-day "phase_advance" entry referencing this phase id.
      const existing = await query(
        `SELECT 1 FROM activity_log
         WHERE entity_type = 'goal_phase'
           AND entity_id = $1
           AND action = 'phase_advance'
           AND created_at::date = $2
         LIMIT 1`,
        [phase.id, today]
      ).catch(() => ({ rows: [] }));
      if (existing.rows.length) continue;
      // Compose the message — which goals become primary today
      const goals = await query(
        `SELECT title, phase_primary, phase_maintenance FROM goals
         WHERE status NOT IN ('failed','complete')`
      );
      const phaseTag = `phase_${phase.phase_number}`;
      const newPrimary = goals.rows.filter(g => (g.phase_primary || []).includes(phaseTag)).map(g => g.title);
      const newMaintenance = goals.rows.filter(g => (g.phase_maintenance || []).includes(phaseTag)).map(g => g.title);
      const msg = `Today starts Phase ${phase.phase_number} — ${phase.phase_name}. `
        + `Primary: ${newPrimary.join(', ') || '—'}. Maintenance: ${newMaintenance.join(', ') || '—'}.`;
      await logActivity('phase_advance', 'goal_phase', phase.id, 'system', msg).catch(() => {});
    }
    return { advanced: r.rows.length };
  } catch (err) {
    console.error('[checkPhaseAdvance]', err.message);
    return { advanced: 0, error: err.message };
  }
}

// ─── POST /api/goals/seed-defaults ────────────────────────────────
// One-shot reseed for the 5 locked goals + 6 phases. Idempotent — uses
// WHERE NOT EXISTS so it won't duplicate if seeds already ran. Use when
// the boot-time seed silently failed (rare) or after a manual purge of
// the goals tables.
router.post('/seed-defaults', async (req, res) => {
  try {
    const phaseSeed = await query(`
      INSERT INTO goal_phases (phase_number, phase_name, start_date, end_date, description)
      SELECT * FROM (VALUES
        (1, 'Riverdale prep',          DATE '2026-05-11', DATE '2026-05-17', 'Lead-in to Riverdale 5K'),
        (2, 'Palmerton build',         DATE '2026-05-18', DATE '2026-06-27', 'Build phase for Palmerton Super'),
        (3, 'Palmerton taper+race',    DATE '2026-06-28', DATE '2026-07-11', 'Taper into Palmerton Super'),
        (4, 'Killington strength',     DATE '2026-07-14', DATE '2026-08-15', 'Strength block for Killington Beast'),
        (5, 'Killington aerobic peak', DATE '2026-08-16', DATE '2026-09-05', 'Aerobic peak before Killington taper'),
        (6, 'Killington taper+race',   DATE '2026-09-06', DATE '2026-09-19', 'Taper + Killington Beast race week')
      ) AS v(phase_number, phase_name, start_date, end_date, description)
      WHERE NOT EXISTS (SELECT 1 FROM goal_phases)
      RETURNING id`);

    const goalSeed = await query(`
      INSERT INTO goals (
        title, category, metric, anchor_value, anchor_date, anchor_source,
        target_value, target_date, linked_exercise_names, linked_workout_types,
        compute_method, phase_primary, phase_maintenance, evidence_label, notes
      )
      SELECT * FROM (VALUES
        ('Pull-ups: 8 strict by Sept 12',         'strength',   'reps',
          4::numeric,    DATE '2025-03-02', 'Fitbod 2025-03-02 4x3 strict pull-ups',
          8::numeric,    DATE '2026-09-12',
          ARRAY['Pull Up','Strict Pull Up']::text[], ARRAY[]::text[],
          'max_reps_single_set',
          ARRAY['phase_4','phase_5']::text[], ARRAY['phase_2']::text[],
          'strong', 'Killington Beast prep'),
        ('Deadlift: 225x5 by Aug 15',             'strength',   'weight_lb',
          200::numeric,  DATE '2024-12-05', 'Last logged Fitbod heavy pull',
          225::numeric,  DATE '2026-08-15',
          ARRAY['Deadlift','Barbell Deadlift']::text[], ARRAY[]::text[],
          'max_weight',
          ARRAY['phase_4']::text[], ARRAY['phase_2']::text[],
          'heuristic', 'Strength foundation for carry events'),
        ('Farmer''s walk: 75lb 60s by Aug 1',     'carry',      'weight_lb',
          65::numeric,   DATE '2026-03-16', 'Spartan-prep grip session',
          75::numeric,   DATE '2026-08-01',
          ARRAY['Farmer''s Walk','Farmer Walk']::text[], ARRAY[]::text[],
          'manual',
          ARRAY['phase_2','phase_4']::text[], ARRAY[]::text[],
          'heuristic', 'Coach updates manually after Hevy farmer walk sessions'),
        ('Stair climber: 90min Z3 by Aug 30',     'vertical',   'duration_min',
          30::numeric,   DATE '2026-05-05', 'Current best sustained Z3 block',
          90::numeric,   DATE '2026-08-30',
          ARRAY[]::text[], ARRAY['hill']::text[],
          'manual',
          ARRAY['phase_5']::text[], ARRAY['phase_2']::text[],
          'heuristic', 'Coach updates from HR sample analysis after each long session'),
        ('Run 5mi @ 9:30/mi by Aug 1',            'run',        'pace_min_per_mi',
          9.0::numeric,  DATE '2026-04-26', 'Vernon NJ Sprint pace at 1mi',
          9.5::numeric,  DATE '2026-08-01',
          ARRAY[]::text[], ARRAY['run']::text[],
          'latest_pace',
          ARRAY['phase_1','phase_2','phase_5']::text[], ARRAY[]::text[],
          'strong', 'Pace target backwards: lower pace_min_per_mi = faster')
      ) AS v(title, category, metric, anchor_value, anchor_date, anchor_source,
             target_value, target_date, linked_exercise_names, linked_workout_types,
             compute_method, phase_primary, phase_maintenance, evidence_label, notes)
      WHERE NOT EXISTS (SELECT 1 FROM goals)
      RETURNING id, title`);

    // Seed history for any newly-inserted goals so trajectory has a baseline
    if (goalSeed.rows.length) {
      await query(`
        INSERT INTO goal_history (goal_id, value, recorded_at, source_note)
        SELECT id, anchor_value, anchor_date, 'anchor'
        FROM goals
        WHERE id = ANY($1)`,
        [goalSeed.rows.map(r => r.id)]);
    }

    res.json({
      ok: true,
      phases_inserted: phaseSeed.rows.length,
      goals_inserted: goalSeed.rows.length,
      goals: goalSeed.rows,
      note: phaseSeed.rows.length === 0 && goalSeed.rows.length === 0
        ? 'No-op — goals/phases already seeded. To force reseed, manually DELETE rows first.'
        : 'Seeded successfully. Refresh dashboard to see goals.',
    });
  } catch (err) {
    console.error('[POST /goals/seed-defaults]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.recomputeForWorkout = recomputeForWorkout;
module.exports.recomputeAllGoals = recomputeAllGoals;
module.exports.checkPhaseAdvance = checkPhaseAdvance;
