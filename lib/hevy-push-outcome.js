// lib/hevy-push-outcome.js
//
// Single source of truth for translating a `pushPlanToHevy` return
// envelope into the persisted (status, detail) pair on daily_plans.
//
//   r = { ok: true,  segments_pushed, total_hevy_segments }    → synced
//   r = { ok: false, skipped: <reason> }                       → skipped
//   r = { ok: false, error: <message> }                        → failed
//   r = { ok: false, results: [...] }                          → walks
//                                                                results[]
//
// Always returns a non-empty `detail` when status is not 'synced' so
// hevy_push_detail never reads null on a failed/skipped push. This is
// the v3.12 fix for the silent-failure pattern flagged in HEVY-
// INTEGRATION-FOR-PLANNING-AGENT.md §"Status tracking on the plan row".
//
// Shared by routes/daily-plans.js (autoPushToHevy fire-and-forget) and
// routes/hevy.js (POST /api/hevy/push-plan manual retry). Extracted into
// a lib module so both can require it without circular-import grief.

'use strict';

function derivePushOutcome(r) {
  if (r && r.ok) {
    return {
      status: 'synced',
      detail: r.segments_pushed != null
        ? `${r.segments_pushed}/${r.total_hevy_segments} segments`
        : 'pushed',
    };
  }
  if (r && r.skipped) {
    return { status: 'skipped', detail: String(r.skipped) };
  }
  if (r && r.error) {
    return { status: 'failed', detail: String(r.error) };
  }
  // Aggregator fallback: pushPlanToHevy didn't surface a top-level
  // reason. Walk results[] ourselves and stitch one together. Shouldn't
  // fire post-v3.12 (the aggregator does this) but keeps detail
  // informative if a future return-shape change re-introduces the
  // silent-failure pattern.
  if (r && Array.isArray(r.results) && r.results.length > 0) {
    const errored = r.results.filter((x) => x && x.error);
    const skipped = r.results.filter((x) => x && x.skipped);
    if (errored.length > 0) {
      return {
        status: 'failed',
        detail: errored.map((x) => x.error).join('; '),
      };
    }
    if (skipped.length > 0) {
      return {
        status: 'skipped',
        detail: skipped.map((x) => x.skipped).join('; '),
      };
    }
  }
  // Absolute last-resort: r is null/undefined or {ok:false} with nothing
  // else attached. At least name the shape so the user sees something.
  return {
    status: 'failed',
    detail: r == null
      ? 'pushPlanToHevy returned null'
      : `pushPlanToHevy returned unknown shape: ${JSON.stringify(r).slice(0, 200)}`,
  };
}

module.exports = { derivePushOutcome };
