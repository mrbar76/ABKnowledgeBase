# Exercise Assets

Per-exercise demonstration images for the Forge catalog additions. Used by the Forge UI when rendering custom Hevy exercise templates (Hevy's native UI doesn't support images for custom exercises).

## Filename convention

`<slug>_<n>.<ext>` — slug derived from the catalog entry name, `n` is the image index (most exercises have 2 images: start position and end position).

Examples:
- `worlds_greatest_stretch_0.jpg` / `_1.jpg`
- `cobra_pose_0.jpg`
- `knee_to_chest_single_0.jpg` (parenthetical preserved to avoid collisions with Double)

## Sources & licensing

- **free-exercise-db** (yuhonas/free-exercise-db) — [Unlicense](https://unlicense.org/). Public domain equivalent. Most images.
- **wger** (wger.de) — [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The following entries use wger imagery and must retain attribution:
  - Walking Lunge with Twist
  - Pigeon Pose
  - Lying Figure-4 Stretch
  - Banded Ankle Distraction
  - Foam Roll Hamstrings
  - Foam Roll Glutes
  - Reverse Nordic

## Coverage

73 surviving catalog entries (after Hevy duplicate dedup from the original 90):
- 27 entries have one or more images stored here
- 46 entries had no DB match or only text-only matches; these need YouTube/web fallback in the editorial pass

The mapping of catalog entry → asset URL list lives in `docs/forge/asset_map.json` alongside this folder.
