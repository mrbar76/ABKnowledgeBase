// Single source of truth for linking a workout row to its daily_plan +
// plan_segment. Called from every workout-insert path:
//   - routes/workouts.js POST /workouts (single + bulk + relink)
//   - routes/health.js Apple Health ingest
//
// Hevy sync (routes/hevy.js) still uses an inline link query because it
// hardcodes logging_target='hevy' (always correct for that path) and
// has additional metadata-merge logic that doesn't generalize. Kept
// separate intentionally.
//
// Linking semantics:
//   1. If caller supplies both daily_plan_id AND plan_segment_id (and
//      force=false), skip lookup; just ensure segment status is marked
//      completed.
//   2. If caller supplies plan_segment_id only: derive daily_plan_id
//      from the segment's FK. No date-based lookup needed.
//   3. Otherwise: look up the plan by workoutDate, then find the
//      segment whose logging_target matches the source-derived
//      preferred target (apple_health / hevy / manual).
//   4. If no matching segment: fall back to first segment AND emit a
//      structured warning log naming the workout id, source, and
//      ai_source — the next misroute is visible in logs without
//      needing a manual diagnostic query.
//   5. Apply the UPDATE. Default semantics: COALESCE (only fill nulls).
//      force=true overwrites existing daily_plan_id / plan_segment_id,
//      required for "move this misrouted workout to the right segment."
//   6. Mark the linked segment status='completed' (idempotent — no-op
//      if already completed).

const { query } = require('../db');

function targetPrefFromSource(source) {
  if (source === 'apple_health') return 'apple_health';
  if (source === 'hevy') return 'hevy';
  return 'manual';
}

async function linkWorkoutToPlan({
  workoutId,
  workoutDate,
  source,
  aiSource = null,
  planSegmentId = null,
  dailyPlanId = null,
  force = false,
}, queryFn = query) {
  if (!workoutId) return { linked: false, reason: 'missing_workout_id' };

  let planId = dailyPlanId;
  let segmentId = planSegmentId;
  let segmentLoggingTarget = null;
  let viaFallback = false;

  try {
    // Early-return path: caller pre-supplied both IDs and isn't forcing.
    // Don't burn a query; just ensure segment is marked completed.
    if (planId && segmentId && !force) {
      await queryFn(
        `UPDATE plan_segments SET status = 'completed', updated_at = NOW()
         WHERE id = $1 AND status IN ('planned','in_progress')`,
        [segmentId]
      );
      return {
        linked: true,
        plan_id: planId,
        plan_segment_id: segmentId,
        already_linked: true,
      };
    }

    // Caller passed plan_segment_id only — derive plan_id from segment FK.
    if (segmentId && !planId) {
      const r = await queryFn(
        `SELECT daily_plan_id, logging_target FROM plan_segments WHERE id = $1`,
        [segmentId]
      );
      if (!r.rows.length) {
        return { linked: false, reason: 'plan_segment_id_not_found' };
      }
      planId = r.rows[0].daily_plan_id;
      segmentLoggingTarget = r.rows[0].logging_target;
    }

    // Look up by date + source when planId or segmentId still missing.
    if (!planId || !segmentId) {
      if (!workoutDate) {
        return { linked: false, reason: 'missing_date_for_lookup' };
      }
      const targetPref = targetPrefFromSource(source);
      const r = await queryFn(
        `SELECT dp.id AS plan_id,
          (SELECT id FROM plan_segments
             WHERE daily_plan_id = dp.id AND logging_target = $2
             ORDER BY block_order LIMIT 1) AS preferred_segment_id,
          (SELECT logging_target FROM plan_segments
             WHERE daily_plan_id = dp.id AND logging_target = $2
             ORDER BY block_order LIMIT 1) AS preferred_target,
          (SELECT id FROM plan_segments
             WHERE daily_plan_id = dp.id
             ORDER BY block_order LIMIT 1) AS first_segment_id,
          (SELECT logging_target FROM plan_segments
             WHERE daily_plan_id = dp.id
             ORDER BY block_order LIMIT 1) AS first_target
         FROM daily_plans dp
         WHERE dp.plan_date = $1
         LIMIT 1`,
        [workoutDate, targetPref]
      );
      if (!r.rows[0]?.plan_id) {
        return { linked: false, reason: 'no_plan_for_date' };
      }
      if (!planId) planId = r.rows[0].plan_id;
      if (!segmentId) {
        if (r.rows[0].preferred_segment_id) {
          segmentId = r.rows[0].preferred_segment_id;
          segmentLoggingTarget = r.rows[0].preferred_target;
        } else {
          segmentId = r.rows[0].first_segment_id;
          segmentLoggingTarget = r.rows[0].first_target;
          viaFallback = true;
        }
      }
    }

    // Apply the link. force=true overwrites existing routing; otherwise
    // COALESCE preserves whatever was already set (the auto-link
    // contract since the column was added).
    const updateSql = force
      ? `UPDATE workouts
            SET daily_plan_id = $1,
                plan_segment_id = $2,
                updated_at = NOW()
          WHERE id = $3 RETURNING id`
      : `UPDATE workouts
            SET daily_plan_id = COALESCE(daily_plan_id, $1),
                plan_segment_id = COALESCE(plan_segment_id, $2),
                updated_at = NOW()
          WHERE id = $3 RETURNING id`;
    const u = await queryFn(updateSql, [planId, segmentId, workoutId]);
    if (!u.rows.length) return { linked: false, reason: 'workout_not_found' };

    if (segmentId) {
      await queryFn(
        `UPDATE plan_segments SET status = 'completed', updated_at = NOW()
         WHERE id = $1 AND status IN ('planned','in_progress')`,
        [segmentId]
      );
    }

    if (viaFallback) {
      console.warn(
        `[workout-link] workout ${workoutId} routed via FALLBACK to ` +
        `segment ${segmentId} (logging_target=${segmentLoggingTarget}); ` +
        `source='${source}' had no matching segment in the day's plan. ` +
        `ai_source='${aiSource || 'n/a'}'. Skill should set source ` +
        `explicitly (apple_health|hevy) to avoid this fallback.`
      );
    }

    return {
      linked: true,
      plan_id: planId,
      plan_segment_id: segmentId,
      via_fallback: viaFallback,
    };
  } catch (err) {
    console.error(`[workout-link] workout ${workoutId} link failed: ${err.message}`);
    return { linked: false, reason: 'error', error: err.message };
  }
}

module.exports = { linkWorkoutToPlan, targetPrefFromSource };
