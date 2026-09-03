# Project Instructions

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
