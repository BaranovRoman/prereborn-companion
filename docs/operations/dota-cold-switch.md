# Dota Cold Switch: implementation and Windows acceptance

Update: stable 0.5.94 was subsequently authorized and published through the existing updater.
Use [the stable release report and first Cold Switch steps](companion-0.5.94-release.md).
The unsigned candidate evidence below records the earlier validation stage.

Implements the approved audit `3073745` on `codex/plugin-runtime-prototype`.
The initial implementation approval excluded release/signing. Package updates, main merge
and automatic migration remain excluded; the subsequent stable release approval is recorded above.
The existing signed Dota 0.1.0 worker and IPC v1 are reused unchanged.

## Production behavior

- Explicit Prepare verifies the installed signed live package separately from session scope.
  It uses the existing consistent backup, additive migration, coordinator and preflight.
  No game session is required; existing backup files are not replaced or removed.
- Explicit Enable selects the existing bound handoff when a real session exists. Otherwise
  the existing ownership transaction rechecks that there is no active/unresolved match or
  open session. Unknown, quota, backup/schema, process and audio fences still apply.
- The same supervised worker starts with an External epoch and durable `session=None`.
  It receives no session-bound commands/effects until a fresh real GSI has genuine match
  evidence according to the existing parser/detector. Cached GSI is not used for bootstrap.
- Real gameplay session creation, revisions, lifecycle ledger/receipt and durable owner
  binding commit in one Immediate SQLite transaction through the existing facade. A failed
  quota/receipt write rolls back everything. A lost binding result resolves the persisted UUID;
  it does not create another session. Match processing then uses the unchanged real IPC path.
- BuiltIn admission is closed throughout External ownership, including demo/idle audio.
  First-version limitation: demo/idle sounds and effects without a real session do not run.
- Fallback without a session uses the same drain, confirmed process stop, game-only audio
  fence and newer BuiltIn epoch. If bootstrap committed but its response was lost, fallback
  resolves that real session first. Unknown or unproven fences keep processing blocked.
- The existing bound/hot path retains its mandatory session and existing OBS fencing.
  There are no new listeners, runtime implementations, protocols, writers or services.

## Closed OBS and storage diagnostics

BuiltIn queues an OBS retry at startup even before connecting. That queued intent and an
error connecting before any scene request are not evidence that an effect was executed.
The existing scene primitive now exposes its actual request-send boundary internally; both
automatic and manual scene calls record a failed, potentially sent request conservatively.
Cold fencing requires no in-flight scene/probe and no such uncertain write. It does not
use cached scene names, clear an uncertain result or force an OBS connection for a proven
idle path. External durable Unknown is checked independently. An uncertain legacy scene
write remains blocking; an unrelated success does not clear that flag. With no connected
OBS transport, a cold-started worker's scene intent is rejected before attempting transport;
normal existing reconnect reconciliation can reapply when an authoritative watcher connects.

Safety status distinguishes `not_prepared` (valid legacy schema, no reserved namespace),
`ready`, and actual storage errors. The UI shows External waiting for a game session and
the demo/idle limitation. Prepare stages, result persistence and concurrent admission remain
the existing native implementation. No database absence/error is treated as an empty session.

Startup handshake remains bounded but now has 5 seconds; commands remain limited to 2 seconds.
A fresh copied executable took 2.84 seconds to enter IPC on macOS, causing intermittent
fail-closed startup failures with the previous 2-second limit. No command retry or bypass was added.

## Targeted validation

Local checks use temporary real-schema SQLite, disposable signed test fixtures and the
existing actual worker. They never use user history or official private signing keys.

- Cold admission and waiting; genuine first GSI, demo exclusion, atomic quota rollback,
  saved receipt/reopen, lost binding reply, same UUID, fallback, Unknown and stale ownership.
- Storage not-prepared versus incompatible/partial namespace without writes.
- Closed OBS connection before scene send and conservative in-flight/uncertain fencing.
- Legacy complete write-set parity; lifecycle/watchdog/core-writer refresh; real IPC
  commit-before-reply recovery; generation/replay fencing; hang/reap and durable pending audio.
- Existing frontend game-only audio/Twitch isolation; Prepare/invoke UI; waiting/not-prepared UI.
- `cargo check`, TypeScript and `git diff --check`.

Initial restricted-sandbox loopback tests were refused by the OS. Subsequent permitted
targeted checks use localhost only. Initial startup-timeout failures were investigated and
fixed as above; they were not interpreted as parity success.

Unsigned Windows validation uses the existing `windows-release.yml`,
`validation_version=0.5.94`, `signing_validation=false`, `dota_candidate=false`.
0.5.94 is an unpublished validation artifact version, not a stable tag/release or updater update.
Code/source commit: `48c3198fa15baacab156f48e7f3be89cf0fd0f39`.

Final results: 18 targeted Rust tests passed (9 cold/storage/OBS and 9 IPC/lifecycle/audio
regressions), 26 frontend tests passed, TypeScript, cargo check and diff check passed.
[Unsigned Windows CI 38611552935](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38611552935)
completed successfully: native supervisor 5 passed / 3 ignored fixture entrypoints,
Prepare UI/invoke 21 passed, Credential Manager smoke, NSIS build, exact installed PE payload
comparison (only the expected NSIS subsystem marker differs), metadata/inventory and synthetic
packaged GSI/overlay/single-instance smoke. `release-windows` and `dota-candidate` were skipped.

[Download CI artifact prereborn-companion-windows](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38611552935/artifacts/11919191055)
(GitHub login required; expiring unsigned artifact). Contains
`PreReborn Companion_0.5.94_x64-setup.exe` and its `.sha256`.
Installer SHA256 from CI:
`eeb1ba1b6a9aaf0b987067471dffb37dbf523114b7ac6e329cef4ab675158d99`.
The Windows pipeline verified the installer. Local download stalled twice, including a
bounded 60-second retry, so a local downloaded-file SHA256 comparison is not claimed.
No updater manifest or public Release was produced.
No local Tauri bundle, full suite, Silero/old-overlay rebuild or cargo clean is needed.

## Windows checklist (ручная проверка)

Это проверка CI-кандидата, а не обновление через stable updater. Установите только проверенный
NSIS из указанного Actions run поверх 0.5.93. До установки закройте Companion и сохраните
отдельную копию app-data для диагностики. Не восстанавливайте её после новых записей.
Официальный Dota 0.1.0 уже установлен; переустановка или ручное копирование worker не нужны.

| Шаг | Действие | Ожидаемый результат / остановка |
| --- | --- | --- |
| 1 | Закрыть Dota и OBS. Запустить candidate. Проверить историю и настройки. | BuiltIn по умолчанию, External не запускается, миграция не стартует. При регрессии прекратить тест. |
| 2 | Плагины → Dota → отметить подтверждение → один раз Prepare. | Native `completed/succeeded`, backup рядом с `local-runtime.sqlite3`, квота и BuiltIn epoch. Нет `builtin_session_required`. При failed прислать attempt/stage/code; не удалять backup и не повторять вслепую. |
| 3 | Один раз включить External при закрытых Dota/OBS. | External, новый epoch, «ожидание игровой сессии», один worker. Нет нового игрового UUID/матча от одного включения. Unknown/Draining — остановить дальнейший тест, не чистить ledger. |
| 4 | Пока игра не запущена, отключить External. Затем включить ещё раз. | Worker завершён, BuiltIn с новым epoch; повторное включение вновь ждёт реальную сессию. Twitch/TTS не останавливаются. |
| 5 | Запустить «Опробовать героя», проверить известный звук. | До реальной сессии звук не играет; BuiltIn не озвучивает его параллельно. Это принятая граница первой версии. |
| 6 | Выйти из demo, начать настоящий матч. | Ожидание сессии исчезает; реальная сессия/матч, правильная история и настроенные звуки, без двойного playback/outbox. При расхождении отключить External безопасной кнопкой и сохранить diagnostics. |
| 7 | Запустить OBS с существующими mapping/WebSocket. Проверить переходы, reconnect и ручную сцену. | Существующая authoritative reconciliation, без слепого повторения Unknown. При Unknown остановить тест, не принуждать takeover. |
| 8 | После post-game, вне матча, отключить External при очереди Twitch TTS. | Подтверждённая остановка worker/game audio, TTS продолжается, BuiltIn получает новый epoch. История не откатывается. При Draining сохранить точный код и остановиться. |
| 9 | Отдельно проверить crash worker/Companion по существующему native checklist. | После restart нет автоматического External. Неподтверждённый process/audio/OBS результат блокирует takeover; после подтверждённых fences — новый BuiltIn epoch. Не восстанавливать старую SQLite и не убивать процесс по предполагаемому PID. |

Прислать: candidate version, runtime/epoch, Prepare attempt/stage/status/code, квоту/Unknown,
результат каждого шага и при ошибке соответствующие строки app.log. Без сырых GSI, токенов,
account IDs и OBS-паролей. Реальные Windows GSI/audio/OBS/crash recovery этими unit/CI проверками
заранее не подтверждаются. Для crash-проверок дополнительно используется
[существующий native checklist](dota-windows-native-smoke.md).
