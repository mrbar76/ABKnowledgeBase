# Brief: re-POST the 73 custom exercises to Hevy (corrected types)

## Context

We already ran this once. **It went wrong.**

The first agent transformed each payload from the file's correct shape:

```json
{ "title": "...", "exercise_type": "duration", "equipment_category": "none",
  "muscle_group": "hamstrings", "other_muscles": ["glutes", "quadriceps"] }
```

…down to a stripped shape it assumed the endpoint required:

```json
{ "title": "...", "muscle_group": "hamstrings", "equipment": "none", "notes": "..." }
```

`exercise_type`, `equipment_category`, and `other_muscles` were dropped on the way to the POST. Hevy then defaulted every template to `exercise_type: weight_reps`. Result: 70 of 73 templates have the wrong type (only 3 were genuinely `weight_reps`).

The endpoint at `routes/hevy.js:1850` always accepted the full schema. The previous agent's "transformation" was the bug, not the schema.

This brief is the re-do. Hevy has no `PUT` or `DELETE` on `/v1/exercise_templates`, so the user is manually deleting the 73 wrong-typed templates in the Hevy mobile app first. Your job starts after deletion is confirmed.

## Pre-conditions you must verify before posting anything

1. **Forge `HEVY_API_KEY` is set** (Railway → forge service → variables). Same key that worked previously.
2. **The 73 wrong-typed templates have been deleted from Hevy.** Verify with:
   ```
   GET /api/hevy/templates/refresh       # force a cache refresh first
   GET /api/hevy/exercise-templates?is_custom=true&limit=200
   ```
   Count custom templates. Before the first (failed) run, baseline was 444 total / N customs. After: 517 total. After user deletes the 73: should be back to ~444 total. If you still see custom titles matching entries in `docs/forge/hevy_post_payloads.json` (e.g. "World's Greatest Stretch", "90/90 Hip Switch"), **stop** — user hasn't finished deleting. Surface the leftover titles and wait.

Do not proceed past step 2 until the catalog is clean.

## The data

`docs/forge/hevy_post_payloads.json` — 73 entries, unchanged from the first run. Each entry has a `payload` field shaped exactly how the Forge endpoint expects it.

Expected type distribution across the 73 (use this to verify the run later):

| `exercise_type` | Count |
|---|---|
| duration | 33 |
| reps_only | 29 |
| short_distance_weight | 6 |
| weight_reps | 3 |
| distance_duration | 2 |

## The endpoint

```
POST /api/hevy/exercise-templates
Content-Type: application/json

Body: the `payload` object from each entry, sent UNCHANGED.
```

The handler (`routes/hevy.js:1850`) destructures exactly these fields:

```js
const { title, muscle_group, equipment_category, equipment,
        exercise_type, other_muscles } = req.body || {};
```

It forwards them to Hevy as `{ exercise: { title, exercise_type, equipment_category, muscle_group, other_muscles? } }`. Every field in your payload reaches Hevy. **Do not rename, drop, or add fields.** In particular:

- ❌ Do not rename `equipment_category` → `equipment` (both are accepted, but the payload file uses `equipment_category` — keep it).
- ❌ Do not add a `notes` field. The endpoint silently ignores it and Hevy doesn't support notes on template creation.
- ❌ Do not collapse `other_muscles` to a single `secondary_muscle_group` string. Hevy's schema is an array.
- ❌ Do not drop `exercise_type`. This is the bug we're fixing.

## THE GOLDEN RULE

For every entry in the JSON: take `entry.payload`, serialize it as-is, and POST it. Zero transformation.

```js
// Pseudocode
for (const entry of payloads) {
  await fetch('/api/hevy/exercise-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry.payload)   // <-- exactly entry.payload
  });
}
```

If you find yourself writing a transformation function, **stop and re-read this section**.

## Methodology

**Step 1 — Sanity POST one entry and VERIFY THE TYPE.**

POST entry `orig_idx: 1` (World's Greatest Stretch, expected `exercise_type: duration`).

Then immediately:
```
POST /api/hevy/templates/refresh
GET  /api/hevy/exercise-templates?q=worlds+greatest&limit=5
```

Inspect the returned record. The `type` field on the returned template **must equal `"duration"`**. If it shows `"weight_reps"`, the transformation bug is back — STOP, do not loop, report what happened.

**Step 2 — Run the loop on the remaining 72.**

Sequential, 200ms sleep between calls. Track per entry:
- HTTP status code
- Response body
- Returned template id (when successful)

**Step 3 — Handle the cosmetic 500.**

A successful POST often returns HTTP 500 with a body like:
```json
{ "error": "Unexpected token 'X', \"<uuid>\"... is not valid JSON" }
```

This is a known Forge response-handler quirk: Hevy returns the new template id as a bare string and Forge's `res.json()` chokes. **The template was still created.** Treat any 500 whose error message matches that JSON-parse signature as success and parse the uuid out of the error string.

Any other 500 (timeout, "fetch failed", 5xx from Hevy upstream) is a real failure — log it and continue.

**Step 4 — Retry transient failures once.**

A 403 with "Host resolves to a private/reserved IP: resolve_no_records" is an egress proxy hiccup (Child's Pose hit this last time). Retry just that entry once after a 2s wait. If it fails again, mark as failed and move on.

**Step 5 — Refresh cache at the end.**

```
POST /api/hevy/templates/refresh
```

**Step 6 — Verification.**

```
GET /api/hevy/exercise-templates?is_custom=true&limit=200
```

Confirm:
1. Custom-template count grew by 73 from the pre-run baseline.
2. Type distribution matches the table above (33 duration, 29 reps_only, etc.). Group the new templates by `type` and report the counts.
3. Spot-check 3 entries by title: pull each from the cache and verify `type`, `primary_muscle_group`, and `equipment` match the source payload.

If type distribution doesn't match expected, do not call the run a success — surface the diff.

## Output to send back

```
Pre-run baseline:  N customs in Hevy (after user deletion)
Total POSTs:       73
Successful:        N
Failed:            N
Cosmetic-500 path: N (counted as success)
Real failures:     N
Duration:          Xs

Type distribution of new templates (must match expected 33/29/6/3/2):
  duration:              N
  reps_only:             N
  short_distance_weight: N
  weight_reps:           N
  distance_duration:     N

orig_idx → hevy_id mapping:
  1 → <id>
  3 → <id>
  ...

Failures (orig_idx, title, error):
  ...
```

If the type distribution doesn't match, paste a list of any entries whose returned `type` differs from `payload.exercise_type`.

## Don't do these

- **Don't transform payloads.** See THE GOLDEN RULE above. This is the entire reason the brief exists.
- **Don't add a `notes` field** for image URLs. They don't persist. Image surfacing is a separate Forge schema task (`hevy_template_cache.image_url` column, tracked in PR #43's follow-up list).
- **Don't try to upload images.** Hevy's POST doesn't accept image data.
- **Don't loop in parallel.** Sequential with the 200ms gap.
- **Don't auto-retry on real 500s.** Only retry the specific egress-proxy 403 once. Everything else gets logged as failed and continued past.
- **Don't refresh the cache after every POST.** Once at the end is enough.

## File locations

| File | Purpose |
|---|---|
| `docs/forge/hevy_post_payloads.json` | 73 POST bodies (source of truth) |
| `docs/forge/cft_brief_hevy_post.md` | The original (now-superseded) brief |
| `docs/forge/cft_brief_hevy_repost.md` | This brief |
| `routes/hevy.js:1850` | The endpoint, for reference if you doubt the schema |

---

That's the brief. The sanity check at Step 1 is the most important guardrail — if the first template comes back with the wrong type, stop and report before the other 72 follow it into the wall.
