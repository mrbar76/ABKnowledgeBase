// Exercise taxonomy — keyword-based modality inference.
//
// The Coach builds plan_segments by grouping prescribed exercises by
// block_label (warmup / cardio / strength / mobility / cooldown) and
// assigning each segment a logging_target (hevy / apple_health / manual).
// This module owns the mapping rules so the Coach (skills) and the
// backend (daily-plans POST backwards-compat) agree on routing.
//
// Routing rules (in order of priority):
//   1. Cardio names (run, treadmill, bike, swim, row, spin) → apple_health
//   2. Strength names (squat, press, deadlift, curl, bench, sled, carry) → hevy
//   3. Mobility / PT names (stretch, mobility, foam, ankle alphabet) → manual
//   4. Fall through to block_label hint (cardio→apple, strength→hevy, else manual)

const CARDIO_PATTERN = /\b(run|jog|treadmill|sprint|spin|cycle|bike|row(?:ing|er)?|swim|elliptical|stair[- ]?master|airdyne|assault|ergo|erg)\b/i;
const STRENGTH_PATTERN = /\b(squat|press|deadlift|curl|bench|push[- ]?up|pull[- ]?up|chin[- ]?up|row|lunge|carry|sled|farmer|snatch|clean|jerk|kettlebell|kb|swing|thruster|hip thrust|rdl|overhead|ohp|dip|fly|raise|extension|lat pulldown|cable|chest)\b/i;
const MOBILITY_PATTERN = /\b(stretch|mobility|cat[- ]?cow|spine rot|thoracic|ankle alphabet|foam roll|cool[- ]?down|warm[- ]?up walk|breathing|yoga|nerve gliding|band pull[- ]?apart|bird dog|dead bug|glute bridge|clamshell|hip flexor)\b/i;
const PT_PATTERN = /\b(eccentric|heel drop|rehab|prophylax|isometric|tibialis|calf raise|toe raise)\b/i;

function inferLoggingTarget(exerciseName, blockLabel) {
  const name = String(exerciseName || '').trim();
  if (!name) return blockLabel ? inferFromBlock(blockLabel) : 'manual';

  // Cardio names take priority — running on a treadmill is cardio,
  // not strength, even though "treadmill" alone might match nothing else.
  if (CARDIO_PATTERN.test(name)) return 'apple_health';

  // Mobility / PT moves go to manual logging (Hevy doesn't capture
  // duration-only or note-only moves cleanly).
  if (MOBILITY_PATTERN.test(name) || PT_PATTERN.test(name)) return 'manual';

  // Strength moves to Hevy.
  if (STRENGTH_PATTERN.test(name)) return 'hevy';

  return blockLabel ? inferFromBlock(blockLabel) : 'manual';
}

function inferFromBlock(blockLabel) {
  const b = String(blockLabel || '').toLowerCase().trim();
  if (b === 'cardio' || b === 'run' || b === 'ride' || b === 'swim' || b === 'recovery') return 'apple_health';
  if (b === 'strength' || b === 'hybrid' || b === 'hill') return 'hevy';
  if (b === 'warmup' || b === 'mobility' || b === 'cooldown' || b === 'pt') return 'manual';
  return 'manual';
}

// Group a flat planned_exercises array into segments by block_label.
// Each exercise can carry an explicit `block` field; if not, infer from
// notes / tags / position. Returns: [{ block_label, logging_target, planned_exercises:[...] }]
function buildSegmentsFromExercises(plannedExercises, defaultWorkoutType) {
  if (!Array.isArray(plannedExercises) || plannedExercises.length === 0) {
    return [];
  }

  const groups = new Map();
  for (const ex of plannedExercises) {
    const block = inferBlockLabel(ex, defaultWorkoutType);
    if (!groups.has(block)) {
      groups.set(block, { block_label: block, planned_exercises: [] });
    }
    groups.get(block).planned_exercises.push(ex);
  }

  const ORDER = ['warmup', 'cardio', 'strength', 'mobility', 'cooldown', 'other'];
  const segments = [...groups.values()].sort(
    (a, b) => ORDER.indexOf(a.block_label) - ORDER.indexOf(b.block_label)
  );

  // Resolve logging_target for each segment: if all exercises in the
  // segment route to the same target, use it; otherwise majority wins;
  // ties fall back to block hint.
  for (const seg of segments) {
    const tally = { hevy: 0, apple_health: 0, manual: 0 };
    for (const ex of seg.planned_exercises) {
      const t = ex.logging_target || inferLoggingTarget(ex.name || ex.title || '', seg.block_label);
      tally[t] = (tally[t] || 0) + 1;
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    seg.logging_target = top && top[1] > 0 ? top[0] : inferFromBlock(seg.block_label);
  }

  return segments;
}

function inferBlockLabel(ex, defaultWorkoutType) {
  // Explicit block label wins.
  if (ex.block || ex.block_label) {
    return String(ex.block || ex.block_label).toLowerCase();
  }
  const tagsRaw = Array.isArray(ex.tags) ? ex.tags : [];
  const tags = tagsRaw.map(t => String(t).toLowerCase());
  const notes = String(ex.notes || '').toLowerCase();
  const name = String(ex.name || ex.title || '').toLowerCase();

  if (tags.includes('warmup') || tags.includes('warm-up') || /warm[- ]?up/.test(notes) || /warm[- ]?up/.test(name)) return 'warmup';
  if (tags.includes('cooldown') || tags.includes('cool-down') || /cool[- ]?down/.test(notes) || /cool[- ]?down/.test(name)) return 'cooldown';
  if (tags.includes('mobility') || tags.includes('pt') || tags.includes('rehab') || MOBILITY_PATTERN.test(name) || PT_PATTERN.test(name)) return 'mobility';
  if (CARDIO_PATTERN.test(name) || tags.includes('cardio') || tags.includes('run') || tags.includes('z2')) return 'cardio';
  if (STRENGTH_PATTERN.test(name) || tags.includes('strength')) return 'strength';

  // Fall back: if the plan's overall workout_type is cardio-shaped,
  // unclassified exercises default to cardio; else strength.
  if (defaultWorkoutType && /run|recovery|ride|swim|cardio/i.test(defaultWorkoutType)) return 'cardio';
  return 'strength';
}

module.exports = {
  inferLoggingTarget,
  inferFromBlock,
  buildSegmentsFromExercises,
  inferBlockLabel,
};
