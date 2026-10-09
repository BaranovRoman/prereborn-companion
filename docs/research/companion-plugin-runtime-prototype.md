# Companion: состояние ядра и внешний Plugin Runtime

## Question

Проверить внешний Rust-процесс и отдельно собранный UI плагина без переноса Dota,
изменения пользовательских данных, backend-контрактов или обновления приложения.
Работа выполнена в `codex/plugin-runtime-prototype`, поверх сохранённой первой
итерации. Публикация, установка в Applications и merge в main не выполнялись.

## Current state

`InnerState` теперь агрегирует `CoreState` и `DotaState` под прежним mutex.
`CoreState` содержит token в памяти, backend connectivity, log_dir и Twitch cache.
`DotaState` содержит прежние GSI/OBS policy, звуки, draft reminder и overlay caches.
Silero и hotkeys сохраняют собственные состояния. Общие callers используют
`inner.core`; Deref/DerefMut адаптер сохраняет доступ старых игровых callers к
Dota-полям. `StatusSnapshot` и его JSON-форма не менялись. Не вводились второй
набор locks, новые пути или миграция SQLite.

## Findings

### IPC v1

`plugins/protocol` — отдельный crate, без Tauri и Dota. Transport: UTF-8 JSON Lines
по stdin/stdout дочернего процесса. Envelope: `protocol: 1`, `message` с tagged
`type`. stdout предназначен только для IPC; stderr непрерывно дренируется.

| Сообщение | Направление и назначение |
| --- | --- |
| hello | Host → plugin: core_api=1 |
| ready | Plugin → host: id, version, min_core_api, max_core_api |
| command / reply | Host → plugin / plugin → host: корреляция по числовому id, name/args и result |
| event / state | Plugin → host: ограниченный список последних событий и последний snapshot |
| stop / stopped | Запрос завершения и acknowledgement |
| error | id optional, code и message; ошибка команды не останавливает здоровый runtime |

Неизвестные сообщения, неправильный envelope, другой protocol version, EOF и
неожиданный reply приводят к Failed и завершению/reap процесса. Handshake принимает
только id=hello и диапазон API, содержащий 1. Protocol version и Core API — отдельные
числа: marketing version приложения не используется для проверки совместимости.
Plugin version информационная; диапазон совместимости объявляет сам плагин.

Lifecycle: Stopped → Starting → Running; ошибка → Failed. Повторный Start во время
работы возвращает already_running. После Stop или Failed разрешён ручной Start,
с новым процессом и очищенным state/events. Автоматического restart loop нет.
Stop идемпотентен; после acknowledgement процесс reaped, при timeout принудительно
завершается. Drop очищает дочерний процесс. Supervisor проверяет выход процесса
каждые 50 ms; он не использует AppState или locks Twitch/TTS.

Ограничения: frame 64 KiB, очередь входящих frames 64, история событий 32,
аргументы команды 512 bytes, timeout handshake/command/stop 2 seconds.
Проверки/команды Tauri выполняются вне UI thread через spawn_blocking. Блокировка
plugin mutex не блокирует core mutex или очередь TTS.

### Hello World и UI

`plugins/hello` — отдельно собираемый Rust executable: greet отдаёт ответ, event
и state; crash используется для проверки отказа. Fault modes для тестов:
incompatible/protocol/malformed/exit/hang. Host UI их при запуске не включает.

`plugins/hello/ui` — отдельный Vite build без imports Companion. Bundle не
встраивается в host: debug Plugin Lab читает его с указанного локального пути через
custom protocol `plugin-ui:`. Canonical-path проверка запрещает traversal/symlink
выход наружу; разрешены только HTML/JS/CSS до 1 MiB. Нет HTTP server fallback,
file://, srcdoc, eval, inline script или allow-same-origin.

Lab имеет отдельную HTML entry point, активируется только debug + --plugin-lab.
В этом изолированном режиме Dota bootstrap не запускается; обычный запуск сохраняет
встроенную Dota. Действует прежний single-instance plugin, поэтому для lab нужно
закрыть существующий Companion. Нормальный Dota UI не изменён.

iframe sandbox=allow-scripts; postMessage проверяет event.source и допускает только
bounded greeting. Мост iframe не предоставляет filesystem/process/Twitch/TTS API. Host
передаёт greeting внешнему процессу и возвращает результат. Ready timeout явно
показывает отказ загрузки, а не успешную имитацию UI.

Первый реальный macOS WKWebView smoke загрузил HTML, но не JS. Inspector подтвердил:
`Refused to load plugin-ui://localhost/assets/index-BeRqsR6H.js because it does not
appear in the script-src directive of the Content Security Policy.` Причина —
`script-src 'self'` при opaque origin sandboxed iframe. Asset response теперь
разрешает scripts/styles только из `plugin-ui:` и CORS для публичных UI assets.
Глобальная CSP приложения и sandbox iframe не ослаблялись.

После исправления проверка именно в macOS WKWebView успешна: host и iframe показали
`IFRAME_OK: Hello, iframe smoke!`, ручная кнопка iframe — `Hello, UI!`. Snapshot
содержал greetings=2 и два greeted events. Crash показал Failed/unexpected_eof,
последующий Start вернул Running, кнопка iframe снова работала с новым state
(greetings=1), Stop показал Stopped. Закрытие окна завершило debug host. В smoke-логе:
`PLUGIN_UI_RESULT IFRAME_OK: Hello, iframe smoke!`. Обычный браузер, classic-script
fallback и отключение sandbox для достижения этого результата не использовались.

### Воспроизводимая проверка

Из корня репозитория, с доступными cargo и pnpm:

```bash
cargo build --manifest-path plugins/Cargo.toml --locked
cargo test --manifest-path plugins/Cargo.toml --locked
pnpm --filter @prereborn/companion exec vite build --config ../../plugins/hello/ui/vite.config.ts
pnpm --filter @prereborn/companion test
cargo test --manifest-path apps/companion/src-tauri/Cargo.toml --lib --locked
pnpm --filter @prereborn/companion build
pnpm --filter @prereborn/companion exec tauri build --debug --bundles app
PREREBORN_HELLO_BIN="$PWD/plugins/target/debug/companion-hello-plugin" \
PREREBORN_HELLO_UI="$PWD/plugins/hello/ui/dist" \
'./apps/companion/src-tauri/target/debug/bundle/macos/PreReborn Companion.app/Contents/MacOS/dota-companion' --plugin-lab
```

Hello binary должен быть собран до host Rust tests: lifecycle tests запускают именно
внешний artifact, не mock и не пропускают проверки при его отсутствии. На Windows
имя executable заканчивается на .exe, пути/env задаются под Windows shell.
В lab проверить greet, Crash → Failed → Start → Running, Stop → Stopped и закрытие
окна. Закрытие test lab останавливает child; helper UI tools нельзя использовать
для повторного getApp после закрытия: они могут открыть обычный Companion снова.

### Автоматические результаты (macOS arm64, 2026-10-10)

- Frontend: 55 файлов, 553 теста успешно; проверка source/type/size iframe bridge.
- Companion Rust: 565 успешно, 3 existing ignored (реальные Silero subprocess и
  OS credential store). IPC/lifecycle tests включают запуск, версии, malformed
  frames, unknown command, timeout, crash, stop, restart и сохранность core state.
- Protocol workspace: 1 тест успешно, включая round-trip, version mismatch,
  неизвестный тип, truncated/oversize frame, EOF. Hello и UI build успешны.
- cargo check, cargo build с tauri/custom-protocol, TypeScript/UI/overlay build и
  сборка macOS debug .app успешны. git diff --check и release contract guard прошли.
- Runtime tests требуют localhost-разрешений для прежних OBS/overlay tests;
  sandbox PermissionDenied не трактовался как дефект приложения.
- В production-конфигурации `--plugin-lab` не активирует runtime. Релиз не выпускался.

## Options

1. Custom protocol + sandboxed iframe + postMessage: минимальный прототип этой
   итерации, проверяется именно в WKWebView. CORS/CSP нужно проверять отдельно для
   каждой платформы.
2. При подтверждённой несовместимости custom scheme в WebView2: отдельный Webview с
   выделенной capability и запретом навигации либо localhost HTTP origin с token и
   sandbox/bridge. Это альтернативы для отдельного решения, не скрытый fallback.

## Recommendation

Не переносить Dota и не принимать недоверенные плагины на базе этого прототипа.
Native child сейчас работает с правами пользователя: env_clear и отсутствие host
API не являются OS sandbox. Подпись, integrity, permissions, process-tree cleanup,
crash telemetry и updater/registry не реализованы. Child descendants не контролируются;
Hello их не запускает. Выход stderr не сохраняется, причина OS crash может быть
только EOF/exit status. Ресурсные OS quotas и универсальный SDK отсутствуют.

## Follow-up

Непроверено на Windows: сборка/запуск внешнего exe с очищенным env, stdin/stdout,
kill/reap и повторный запуск; WebView2 iframe/custom protocol/CSP/CORS; capability
изоляция и отсутствие доступа iframe к host IPC; packaged paths; real Silero/skip;
Credential Manager; regression Dota/GSI/OBS/SQLite/overlay, autostart/tray/single-instance.
Live Twitch/TTS одновременно с падением плагина не проверялись с реальным аккаунтом;
проверены архитектурная независимость locks и автоматические регрессии очереди.

Следующий шаг: зафиксировать parity smoke и границу permissions/lifecycle, затем
согласовать платформенный способ hosting UI. Dota extraction, магазин/скачивание,
пути данных и механизм обновления остаются вне этой итерации.

## Sources

- Исходники state/core/dota/plugin_lab, plugins/protocol и plugins/hello в этой ветке.
- [Tauri custom protocols / WebviewWindowBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html).
- [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).
- [MDN module CORS requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules).
- [Tauri issue: iframe custom protocol on Windows](https://github.com/tauri-apps/tauri/issues/11505) — известное сообщение об отказе, не доказательство для установленной версии/WebView2.
