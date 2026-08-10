---
name: review-pr
description: >
  After a human has looked at a ticket's draft PR and is happy with it, mark the PR ready for
  review on GitHub (undraft it) and move the Weeek ticket to its Review column. This is the
  manual-approval gate that the `ticket` skill deliberately stops short of. Use when the user says
  "/review-pr <id>", "PR for 123 is ready", "move ticket 123 to review", "undraft the PR for WK-123".
allowed-tools:
  - Bash
  - Read
  - mcp__weeek__weeek_get_task
  - mcp__weeek__weeek_list_board_columns
  - mcp__weeek__weeek_move_task
---

# /review-pr — mark PR ready + move ticket to Review

## Procedure

1. **Resolve the ticket id** from `$ARGUMENTS` (digits from `123` / `WK-123`). `BRANCH=feat/<digits>`.

2. **Find the PR.** `gh pr view "$BRANCH" --json number,isDraft,url`. If none exists, tell the user
   to run `/ticket <id>` first and stop.

3. **Mark it ready.** If `isDraft` is true: `gh pr ready "$BRANCH"`. If already ready, skip.

4. **Resolve the ticket's Review column dynamically.** `mcp__weeek__weeek_get_task(task_id=ID)` →
   `boardId` + current `boardColumnId`. `mcp__weeek__weeek_list_board_columns(board_id)` → match the
   column named "Review" (or local equivalent, e.g. `review`, `на проверке`) — never hardcode the id.

5. **Move the ticket (guarded).** Only move if the current column looks like "In Progress" (or a
   blocked-equivalent state) — i.e. it hasn't already reached Review or later:
   `mcp__weeek__weeek_move_task(task_id=ID, board_column_id=<review id>)`. If already at Review or
   past it, report the existing state instead of moving.

6. **Report** the PR URL and the ticket's resulting board column.

## Guardrails

- This skill IS the manual-approval signal — only run it when the user confirms the PR was actually
  looked at, not automatically after `/ticket`.
- Never merge the PR — marking it ready only signals it's reviewable; a human merges via GitHub.
- Status moves only ever advance; never move a ticket backward or past Review.
