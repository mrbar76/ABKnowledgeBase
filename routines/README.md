# Coach Routines (Claude Code, scheduled)

These are the **autonomous, scheduled** half of the Coach. They run on a
clock without Avi having to ask. Each routine reads from AB Brain (and
Apple Health when AB Brain is stale), writes a `coaching_session` record
back to AB Brain, and that record surfaces in the home-tab "Today's Brief"
card the next time Avi opens the app.

The conversational half lives in `/skills/` — those are user-triggered
during a Claude Project chat.

## Setup

Each routine is a procedure document. To activate one in Claude Code:

1. Open Claude Code
2. Run `/loop <interval> <routine-name>` or set up a scheduled task per
   the schedule listed in the routine doc
3. Point Claude Code at the routine doc as the prompt
4. Make sure Claude Code has the AB Brain MCP / API key configured AND
   Apple Health MCP configured

## v1 routine set

| File | When | Replaces from old draft |
|------|------|-------------------------|
| `morning-brief.md` | 5am daily | morning-check-in, plan-week (Sun), race-week-protocol (when ≤14d), monthly-physiology-check (1st of month) |
| `evening-review.md` | 9pm daily | review-day, review-week (Sun) |

5 logical workflows folded into 2 cron slots. Sunday / monthly / race-week
logic activates conditionally inside the morning brief based on date and
AB Brain state.

## Output format

Both routines write a `coaching_session` record:

```json
POST /api/training/coaching
{
  "session_date": "YYYY-MM-DD",
  "title": "Morning brief — 2026-05-03" | "Evening review — 2026-05-03",
  "summary": "...",
  "key_decisions": [],
  "adjustments": [],
  "injury_notes": "...",
  "nutrition_notes": "...",
  "recovery_notes": "...",
  "next_steps": "...",
  "ai_source": "claude",
  "tags": ["routine", "morning_brief" | "evening_review"]
}
```

The home-tab "Today's Brief" card filters to `tags @> '["morning_brief"]'`
and `session_date = today`.

## Voice

Routines use the same voice as the conversational Coach — see
`/docs/coach-project-instructions.md`. Lead with the answer. Brief by
default. INTENT-first prescriptions. ADHD-aware: tangible specific
process praise, no fluff.
