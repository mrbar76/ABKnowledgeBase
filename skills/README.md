# Coach Skills (Claude Project, conversational)

These are the **conversational, user-triggered** half of the Coach.
Avi opens a Claude Project chat and one of these fires based on what he
says. Each Skill describes a multi-step workflow.

The autonomous, scheduled half lives in `/routines/`.

## v1 Skill set (4 Skills)

| File | Triggers when Avi says... |
|------|--------------------------|
| `amend-day.skill` | "I'm sore" / "feeling off" / "want to swap to Z2" / any signal that today's plan needs adjustment |
| `log-fueling-rehearsal.skill` | (after logging a workout ≥ 60min) "let me log the fueling" / "ate a gel and salt at hour 2" |
| `race-debrief.skill` | "I just finished the race" / "race recap" / "how did I do" (post-race) |
| `image-intake.skill` | (when Avi sends a photo) — auto-fires on food / RENPHO / Apple Watch / Fitbod screenshots |

## Setup

1. Install the Anthropic `skill-creator` plugin at https://claude.com/plugins
   *(optional — these Skills are valid markdown without it; skill-creator
   helps for future authoring)*
2. Create a Claude Project on claude.ai
3. In the Project's Skills panel, upload each `.skill` file
4. The Project will read frontmatter (`description` triggers Skill matching)

## Frontmatter format used

```yaml
---
name: skill-name
description: What this skill does and the situations that should trigger it (this is what Claude reads to decide when to invoke)
when_to_use: optional further detail
---
```

## Voice

Skills inherit the voice from `/docs/coach-project-instructions.md`. Lead
with the answer. Brief by default. INTENT-first prescriptions.
ADHD-aware: tangible specific process praise, no fluff.
