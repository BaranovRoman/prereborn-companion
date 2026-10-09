# Companion: границы ядра и встроенной Dota, итерация 1

## Question

Как подготовить приложение к Plugin API без изменения поведения Dota на действующих
стримах? Эта итерация вводит внутренние границы; она не позволяет отключать, скачивать
или одновременно запускать несколько игровых runtime.

## Current state

Tauri 2 / Rust, React 19 / TypeScript / Vite, pnpm. Dota продолжает входить в тот же
бинарный файл. `AppState`, backend-клиент, команды и часть OBS policy пока смешанные:
их полное разделение отложено, чтобы не менять wire-контракты и жизненный цикл.
Windows — целевая платформа; проверки на macOS не доказывают работоспособность
Credential Manager, WebView2, глобальных клавиш и реальной интеграции с Dota/OBS.

## Findings

### Зафиксированные контракты

| Область | Инвариант текущей реализации |
| --- | --- |
| Запуск | Single-instance остаётся первым Tauri plugin. Один `BuiltInDotaRuntime` на приложение. Storage → Silero/hotkeys → Dota state → logs/diagnostics → Dota ingest → backend → OBS → Dota workers. Три `Once` защищают от повторного старта этих фаз; остановка/перезапуск runtime пока не предоставляются. |
| Dota / GSI | Автопоиск и ручной выбор папки, имя `gamestate_integration_dota_companion.cfg`, bind `127.0.0.1:3665`, параметры cfg и формат JSON не меняются. HTTP acknowledgement остаётся до обработки payload. После parse/diagnostics синхронные потребители вызываются в прежнем порядке: OBS → sounds → local runtime → draft reminder, затем обновляются последний payload, dirty flag и версия для backend-forwarding. |
| OBS | WebSocket v5 Hello/Identify, пароль, rpcVersion, subscriptions, request envelopes, ping/pong, таймауты и ошибки сохраняются. Core transport получает только host/port/password. Выбор Dota сцен, watcher, reconnect, lifecycle локальной сессии остаются в прежнем адаптере `obs.rs`. |
| Twitch / аккаунт | Имена и аргументы Tauri команд login/logout, chat, connect/disconnect неизменны. Twitch polling не зависит от GSI и принадлежит одной сессии AppShell; переключение вкладки не создаёт вторую очередь. Backend endpoints и auth остаются прежними. |
| TTS | Silero status/enable/voice/synthesis и skip hotkey используют прежние команды и события. Настройки localStorage сохраняются. Полный текст передаётся движку; ограничение длины — только явная настройка пользователя. FIFO, отмена текущего сообщения, игнорирование запоздалого результата synthesis и fallback не меняются. Игровые звуки и draft reminder остаются отдельными потребителями. |
| SQLite / история | `app_data/local-runtime.sqlite3`, WAL, существующие schema/user_version, ID матчей/сессий, outbox и sync unchanged. Новых миграций нет. Обработка результатов, lifecycle, recovery и watchdog не переписаны. |
| Overlay | `127.0.0.1:3666`, `/overlay`, `/overlay/state`, `/overlay/events` SSE, встроенный renderer, snapshot/push и quiz/OpenDota cache сохраняются. URL источников OBS не меняются. |
| Данные / релиз | Identifier и credential namespace `com.romanbaranov.dota-companion`, пути конфигурации/логов/звуков/секретов, имена команд, события и упаковка сохранены. Установщик, updater и production backend не изменены. |

### Реализованные границы

- `src/core/contracts.ts` и `src/core/api.ts`: account/Twitch/TTS/skip/trace без
  игровых типов. Chat и AccountForm используют их напрямую. Старый
  `services/dotaCompanionApi.ts` реэкспортирует эти функции для совместимости.
- `src-tauri/src/core/obs_transport.rs`: только wire transport OBS; не получает
  `AppState`, игровые типы или правила сцен. `obs.rs` сохраняет прежний интерфейс.
- `src-tauri/src/dota`: bootstrap встроенной Dota, GSI конфигурация/поиск,
  broadcast-state mapper и единая точка fan-out GSI. Корневые Rust aliases
  сохраняют существующих callers. Startup адаптер — единственный владелец запуска
  игровых сервисов в composition root, но пока использует legacy AppState.

Это подготовка Plugin API, а не универсальный SDK. Будущий host API должен
предоставлять узкие сервисы OBS/TTS/settings/events вместо передачи AppState,
SQLite connection или backend credentials плагину. Dota policy останется владельцем
своих типов и runtime. Не вводить второго владельца GSI/worker/overlay.

### Проверки после изменения

| Сценарий | Автоматическая проверка | Обязательный Windows smoke |
| --- | --- | --- |
| Core / совместимость | Новые IPC tests проверяют прежние команды, payload, result/error, legacy reexports и длинный текст. Dependency guard проходит по локальным imports, включая type-only, и запрещает игровые контракты в core/chat. | Login/logout, Twitch OAuth/reconnect с реальным аккаунтом. |
| Startup | Guard composition root + Rust concurrent Once test; прежние bootstrap вызовы сохранены. | Повторный запуск exe/автостарт/трей: один процесс, один listener и один набор workers; второй экземпляр фокусирует первый. |
| GSI / Dota | Существующие mapper/config и real GSI → local runtime tests. Перенесённые GSI/mapper файлы без изменения алгоритмов. | Автопоиск, ручной выбор и cfg; запуск Dota, draft → game → postgame, выход из Dota и возврат. |
| OBS / сессии | Существующие fake OBS watcher/reconnect/event-interleaving tests плюс authenticated handshake/request test нового транспорта. | OBS с паролем, start/stop stream, сцены draft/game/postgame, reconnect после перезапуска OBS, отсутствующая сцена. |
| SQLite / история | Существующие migration/store/lifecycle/watchdog/sync tests. | Обновление поверх текущей установки с сохранённой базой; история/незавершённый матч, offline → online sync без дублей. |
| TTS / звуки | Существующие queue/skip/fallback/long-message и draft reminder tests. | Реальный Silero, сообщения >200 символов, очередь A/B/C, skip во время synthesis/playback, смена вкладки; Dota звуки и reminder во время стрима. |
| Overlay | Существующие renderer/state/quiz/cache tests и сборка embedded renderer. | Старый OBS browser source, SSE обновления во время матча, disconnect/reconnect, quiz и история. |

CI явно запускает companion Vitest suite: root `pnpm test` сам её не запускал.
Успешные автоматические тесты не разрешают пропускать Windows smoke. До него
готовность к production-стриму не подтверждена.

### Результат проверки 2026-10-10 (macOS arm64)

- `pnpm --filter @prereborn/companion test`: 54 файла, 552 теста успешно.
  После исправления переносимости путей guard для Windows повторный `vitest run
  src/core`: 20 тестов успешно.
- `cargo test --manifest-path apps/companion/src-tauri/Cargo.toml --lib --offline
  -- --quiet`: 561 успешно, 3 ignored (два реальных Silero subprocess-теста и
  реальное OS credential storage). Первый sandbox-запуск блокировал 18 localhost
  socket-тестов; повтор с разрешёнными локальными сокетами прошёл полностью.
- `pnpm --filter @prereborn/companion build`: TypeScript, overlay renderer и UI
  production build успешно.
- `cargo check --manifest-path apps/companion/src-tauri/Cargo.toml --lib --offline`
  и `cargo build --manifest-path apps/companion/src-tauri/Cargo.toml --offline`:
  успешно. Native build здесь — macOS debug, не Windows installer.
- `bash scripts/verify-companion-release-contract.sh`, `git diff --check`:
  успешно. GSI/mapper moves побайтово идентичны HEAD; тела OBS transport функций
  сохранены (в open убран только лишний borrow password). Identifier, schema,
  state/backend/storage/game-sounds контракты в исходниках не менялись.
- Предупреждения сборки: Vite `/logo-new.png` разрешается во время выполнения;
  Rust `game_sounds::events::detect_events` не используется в production build.
  Эти участки данной итерацией не изменялись.

Windows smoke, реальный игровой стрим и откат поверх пользовательской установки
не выполнялись. Новый релиз не публиковался.

## Options

1. Сразу разделить AppState/backend и ввести внешний runtime: большой риск изменения
   lifecycle, credential/storage и контрактов, выходит за рамки итерации.
2. Сохранить legacy адаптеры и последовательно выделить game-free сервисы: выбранный
   вариант, допускает проверку и откат каждого шага без миграции данных.

## Recommendation

Сначала пройти Windows smoke на существующих данных. До этого не выпускать обновление
для действующих стримов. Откат данной итерации — возврат к предыдущему бинарному
релизу/исходникам: schema, пути и идентификаторы не менялись. Перед smoke сохранить
копию app_data и конфигурации, не удалять credentials или базу при переустановке.
Эта процедура отката требует ручной проверки на Windows; автоматически она здесь
не подтверждена.

## Follow-up

Следующий безопасный шаг — выделить узкие Rust host-service контракты и отделить
Dota state от общего статуса через совместимый адаптер, добавляя contract tests
для старых status/commands и GSI → OBS → session путей. Сохранить один встроенный
runtime до достижения parity. Не вводить магазин, установщик, динамический код,
новую БД, переименование identifier, новую очередь TTS или новый процесс в этой
итерации. Остаточные зависимости: AppState, смешанный backend/commands/diagnostics,
OBS policy ↔ local lifecycle и game UI ↔ StatusSnapshot.

## Sources

Подтверждено чтением исходников: `apps/companion/src-tauri/src/lib.rs`,
`server/mod.rs`, `dota/gsi/config.rs`, `obs.rs`, `local_runtime/{mod,schema}.rs`,
`overlay_server.rs`, `commands.rs`, `state.rs`, `src/chat/useTwitchChatSession.ts`,
`src/services/dotaCompanionApi.ts`, `.github/workflows/windows-release.yml`.
Внешние сведения и измерения производительности для этой итерации не использовались.
