# Project Instructions

## Ticket → Release

A ticket is finished only when it is released to production and verified, not at a commit, PR,
or green tests. Follow the "Ticket → Release (default task lifecycle)" section and the
"How releases actually ship here" notes in [AGENTS.MD](AGENTS.MD). They are the source of truth
for both Claude and Codex sessions. Releases still go through the environment's normal permission
prompts; don't work around them.

## Weeek tasks

When creating or reformatting tasks in Weeek for this project, follow the format defined in
[docs/weeek-task-standard.md](docs/weeek-task-standard.md): Название, Контекст, Мотивация, Цель,
Описание, Ожидаемый результат, Не входит в задачу, Критерии приёмки, Связанные задачи (при
необходимости), Заметки (опционально).

## Companion UI visual QA

When capturing screenshots for visual review of Companion (`apps/companion`) UI work:

- **1920×1080** is the primary desktop visual baseline — the composition should be judged here
  first.
- **2560×1440** is a required large-desktop visual check (generous space must not produce dead
  gaps, oversized elements, or edge-hugging content).
- **1024×720 is not a product/design target** and must not drive composition decisions — it exists
  only as a lower-bound "does it still fit" check.
- Low resolutions (1024×720 and below) may be used as optional technical/smoke checks for
  catastrophic overflow or breakage, never as the basis for sizing/spacing choices.
