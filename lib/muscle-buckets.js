'use strict';

// v3.35 Feature 2 — the ONE place Hevy muscle names map to Avi's program
// volume buckets. Edit here and every consumer (weekly volume endpoint,
// weekly-review insights, backfill) follows.
//
// Hevy's muscle vocabulary (verified against api.hevyapp.com OAS,
// ExerciseTemplate.primary_muscle_group / secondary_muscle_groups):
//   abdominals, abductors, adductors, biceps, calves, cardio, chest,
//   forearms, full_body, glutes, hamstrings, lats, lower_back, neck,
//   quadriceps, shoulders, traps, triceps, upper_back
//
// Program buckets: delts, chest, back, arms, quads, hinge, calves, core.
//
// Judgment calls (documented so they're deliberate, not accidental):
//   - traps → back (conventional; not delts)
//   - lower_back → back (not hinge/core)
//   - arms folds biceps + triceps + forearms
//   - hinge folds hamstrings + glutes
//   - abductors, adductors, cardio, full_body, neck → intentionally
//     UNBUCKETED. An exercise whose primary muscle is one of these (and
//     whose secondaries don't bucket either) surfaces in
//     unmapped_exercises rather than being silently dropped.

const HEVY_MUSCLE_TO_BUCKET = {
  shoulders: 'delts',
  chest: 'chest',
  lats: 'back',
  upper_back: 'back',
  lower_back: 'back',
  traps: 'back',
  biceps: 'arms',
  triceps: 'arms',
  forearms: 'arms',
  quadriceps: 'quads',
  hamstrings: 'hinge',
  glutes: 'hinge',
  calves: 'calves',
  abdominals: 'core',
};

// Ordered list of program buckets (drives response shape + seed order).
const BUCKETS = ['delts', 'chest', 'back', 'arms', 'quads', 'hinge', 'calves', 'core'];

// Seed targets (working sets per week). calves + core have no target yet
// per the program — they still appear in output with null target_min/max.
const SEED_TARGETS = {
  delts: { min: 10, max: 12 },
  chest: { min: 8, max: 10 },
  back: { min: 12, max: 14 },
  arms: { min: 6, max: 8 },
  quads: { min: 8, max: 10 },
  hinge: { min: 6, max: 8 },
  // calves, quads/core: intentionally omitted (no target yet)
};

// Normalize a raw Hevy muscle string → canonical key. Hevy sends
// lowercase snake_case; be defensive about spaces/case/plural drift.
function normalizeMuscle(m) {
  if (!m) return null;
  return String(m).toLowerCase().trim().replace(/\s+/g, '_');
}

// Muscle → bucket, or null if that muscle isn't in any program bucket.
function bucketForMuscle(muscle) {
  const key = normalizeMuscle(muscle);
  if (!key) return null;
  return HEVY_MUSCLE_TO_BUCKET[key] || null;
}

module.exports = {
  HEVY_MUSCLE_TO_BUCKET,
  BUCKETS,
  SEED_TARGETS,
  normalizeMuscle,
  bucketForMuscle,
};
