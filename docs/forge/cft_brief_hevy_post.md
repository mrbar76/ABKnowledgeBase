# Brief: bulk-add 73 custom exercises to Hevy via Forge API

## Context

We've finished curation, dedup, and asset matching for a catalog of 90 proposed exercises. After cross-referencing against the existing Hevy catalog, 17 were dropped as duplicates and **73 survived for addition**. Metadata (type, muscle groups, equipment) has been pre-filled for every entry. Image URLs (hosted at `raw.githubusercontent.com/mrbar76/abknowledgebase/main/assets/exercises/...`) are included for human reference — **Hevy doesn't support uploading images for custom exercises**, so they won't show inside the Hevy app, only in Forge's UI once the schema work to surface them is done.

Your job is the mechanical POST loop: hit Forge's `/api/hevy/exercise-templates` endpoint 73 times, one per entry. Forge proxies to Hevy and writes through to the local `hevy_template_cache` automatically.

## The data

The payloads live at `docs/forge/hevy_post_payloads.json` in the Forge repo. Each entry has this shape:

```json
{
  "orig_idx": 1,
  "title": "World's Greatest Stretch",
  "payload": {
    "title": "World's Greatest Stretch",
    "exercise_type": "duration",
    "equipment_category": "none",
    "muscle_group": "hamstrings",
    "other_muscles": ["glutes", "quadriceps"]
  },
  "has_assets": true,
  "image_urls": [
    "https://raw.githubusercontent.com/mrbar76/abknowledgebase/main/assets/exercises/worlds_greatest_stretch_0.jpg",
    "https://raw.githubusercontent.com/mrbar76/abknowledgebase/main/assets/exercises/worlds_greatest_stretch_1.jpg"
  ],
  "reference_source": "free-exercise-db"
}
```

The `payload` field is what to POST. Everything else is for your reference (and for the editorial pass to verify imagery later).

## The endpoint

```
POST /api/hevy/exercise-templates
Content-Type: application/json

Body: the `payload` field from each entry above.
```

Required fields: `title`. All others have safe defaults but we're sending them explicitly to be deterministic.

On success: returns `{ ok: true, id: "<hevy_template_id>", template: {...} }`.

## Methodology

**Step 1: sanity-check one entry before the loop.**

POST just the first entry (`#1 World's Greatest Stretch`). Confirm:
1. Response is `200 OK` with `ok: true` and an `id`.
2. `GET /api/hevy/exercise-templates?q=worlds+greatest&limit=5` returns the new template in `results`.
3. The Hevy app itself shows the new custom exercise (open Hevy → start a workout → search for it).

If any of those fail, stop and report before proceeding.

**Step 2: run the loop.**

Iterate through the 73 entries in the JSON file. POST each one. Track:
- HTTP status code
- Returned `id` (or error message)
- Time elapsed

Pace yourself — add a 200ms sleep between calls to avoid hammering Hevy's API.

**Step 3: refresh the cache once at the end.**

After all 73 are posted, call:
```
POST /api/hevy/templates/refresh
```

This makes sure Forge's cached view is consistent with what's actually in Hevy.

## Output to send back

A summary in this shape:

```
Total POSTs:    73
Successful:     N
Failed:         N
Duration:       Xs

Successful template IDs (entry_idx → hevy_id):
  1 → <id>
  2 → <id>
  ...

Failures (entry_idx, title, error):
  17 → "Walking Lunge with Twist" → <error message>
  ...
```

If any failures, paste the full error response body for each. I'll diagnose and re-run just the failed subset.

## Error scenarios and what to do

- **401/403 on POST**: API key issue. Confirm `HEVY_API_KEY` is set in Forge's environment (Railway → forge service → variables). Same key that worked for your earlier GET /exercise-templates loop.
- **400 "title required"**: a payload was malformed. Send me the entry index, I'll fix the data.
- **400 with field validation error from Hevy** (e.g., bad `exercise_type` enum): tell me which entry, I'll correct the metadata.
- **500 with `error: 'fetch failed'`**: Hevy's API may be rate-limiting or down. Wait 5 minutes and retry just the failed ones.
- **Duplicate-title error**: Hevy might reject a title that's identical to a stock entry. Tell me which one — we'll either rename or drop the entry. (Shouldn't happen because we already deduped, but flag if it does.)

## Don't do these

- **Don't try to upload images.** Hevy's `POST /v1/exercise_templates` doesn't accept image data. The image URLs in the JSON are for Forge's display layer (separate engineering task), not Hevy.
- **Don't loop in parallel.** Sequential is safer; Hevy's rate limits aren't well documented and a parallel burst could trip something.
- **Don't auto-retry on 500 in the loop.** Mark as failed and continue. We'll retry the failures after triaging the error pattern.
- **Don't modify the payload metadata in-flight.** If something looks wrong (e.g., a stretch tagged as `weight_reps`), flag it and stop — don't silently fix.

## Verification once done

After your summary comes back, I'll:
1. Cross-reference the 73 IDs against the `hevy_template_cache` table to confirm they all landed.
2. Confirm `is_custom = TRUE` for each.
3. Hand off to the next phase (Forge UI work to surface images per template).

## File locations (in the Forge repo)

| File | Purpose |
|---|---|
| `docs/forge/hevy_post_payloads.json` | 73 POST bodies + image refs |
| `docs/forge/asset_map.json` | Catalog entry → asset URL list (same data, different shape) |
| `docs/forge/asset_map.md` | Human-readable asset map |
| `assets/exercises/` | The 47 image files (committed) |
| `assets/exercises/README.md` | Source attribution (wger CC-BY-SA notes) |

Branch: `forge/exercise-assets`. All of the above lives on that branch. Merge to main before the URLs above resolve via `raw.githubusercontent.com/.../main/...`. Or use `/forge/exercise-assets/` in URLs for testing pre-merge.

---

That's the brief. Send the summary back when done.
