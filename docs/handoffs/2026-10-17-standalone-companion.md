# Передача работы: независимый Companion и устанавливаемый Dota-плагин

Дата: 17.10.2026, Asia/Krasnoyarsk. Работа остановлена по явной просьбе пользователя.
Не продолжать реализацию или публикацию только ради оформления этого отчёта.

## 1. Какую задачу продолжать

Это **полная реализация и выпуск независимого core + отдельного Dota-пакета**,
а не прежние итерации Cold Switch/BuiltIn. Канонический запрос и разрешение:

`/Users/romanbaranov/.codex/attachments/f9d862a5-ae3d-4f3c-ab93-692b6764eda8/Вставленный текст.txt`

Прочитать целиком. Пользователь разрешил автономно выполнить код → проверки →
Windows CI/исправления → официальный подписанный Dota package/catalog → проверку
установки/обновления → обычный подписанный stable Companion/updater. Повторные
согласования публикации в этом запросе не требуются. Однако **сейчас пользователь
попросил остановиться и передать работу**, поэтому следующий агент должен получить
от него команду продолжить. Не выпускать заведомо неполную замену.

Целевой core: Twitch/chat/TTS/Silero, generic OBS transport/automation, плагины,
настройки, диагностика, updater. BuiltIn Dota и fallback удаляются физически.
Игра целиком поставляется отдельным пакетом: GSI 3665, звуки demo/solo bots без
OBS/стрима/фиктивных сессий, история, OBS-правила, overlay 3666, игровой UI.
Функциональный ориентир — 0.5.90. Не возвращать BuiltIn как обходной путь.

Ограничения:

- Не merge main. Не менять пользовательский `.gitignore` и базу на Mac.
- Сохранить identifier, paths и updater signing key.
- Подготовка backup/migration только вручную, включение плагина явно; не autostart.
- Не создавать новые runtime/protocol envelopes/диагностические harness.
- Не выдавать synthetic/CI проверки за реальный Techies/Dota/OBS smoke.
- Mac M1: целевые проверки, без cargo clean/тяжёлых toolchains/локальных app bundles.
- Никаких AI-функций. Не публиковать частично работающий релиз.

## 2. Репозиторий и состояние Git

Рабочая папка: `/Users/romanbaranov/Sites/prereborn-companion`.
Ветка: `codex/plugin-runtime-prototype`.
HEAD и origin этой ветки на момент передачи:
`44b373a0cc68a3d301794ebc07721e944a069db4`.

Последние отправленные коммиты:

- `44b373a` — geometry через реальный outbox, frozen Unknown/recovery.
- `830630f` — backend refresh overlay, durable quiz transitions, bounded chat.
- `5b162c8` — реальный редактор overlay, managed images, GSI publication race,
  раздельные speech/media lanes с общим fence.
- `d140164` — signed settings requests, durable receipts, worker cache.
- `47fab84` — package-owned overlay visibility/summary/native hotkey.
- `6694dc6` ранее — физическое удаление BuiltIn/game-кода из core.

**Есть незакоммиченные изменения**, их сохранить и завершить, не перезатирать:

- `.github/workflows/windows-release.yml`: добавить HeroStatistics test в выбранные UI проверки.
- `apps/companion/src-tauri/src/core/plugin_manager/worker.rs`: readonly resource
  может вернуть handled:false без фиктивного cache apply; PUT/POST по-прежнему
  требуют applied:true. Чистый regression test на эту границу проходит.
- `plugins/dota/src/history.rs`: bounded real hero statistics; SQL failure не
  превращается в фальшивые нулевые матчи; regression проходит.
- `plugins/dota/src/worker.rs`: history.hero; явно uncached hero-stats/insights.
- `plugins/dota/ui/src/App.tsx`, `App.test.tsx`, `overlayApi.ts`,
  `overlayApi.test.ts`, `services/dotaCompanionApi.ts`, `style.css`.
- Новые **неотслеживаемые source-файлы**, обязательно добавить при коммите:
  `plugins/dota/ui/src/components/HeroStatistics.tsx` и `.test.tsx`.
- Данный handoff тоже пока не закоммичен.

Не включать в коммит:

- `.gitignore`: пользовательские прежние +2 строки; НЕ ТРОГАЛИ.
- `plugins/dota/ui/node_modules`: локальный symlink на core node_modules.
- `plugins/tools/tests/__pycache__/`, `scripts/__pycache__/`.

Последний `git diff --check` прошёл. Не использовать blanket `git add plugins`.
Коммитить только scoped paths + конкретные новые source-файлы.
Git/network требуют tool escalation; обычные команды bash, `pnpm`.
По последнему developer instruction не запускать subagents без явного запроса.

## 3. Что уже реально перенесено

Core больше не компилирует Dota-domain/storage/worker или игровой UI. Из core
удалены старые game dirs, GSI/overlay серверы, игровые экраны/ассеты/лаборатория,
draft-reminder и специальные Dota runtime модули. Game facade/SQL/алгоритмы
живут в plugins/dota-domain и plugins/dota-storage и используются одним worker.
Старые exe/lib имена и identifier оставлены намеренно для upgrade совместимости.

Основной интерфейс — шесть нейтральных разделов CoreShell. Старые реальные
Twitch/TTS hooks и очередь сохранены. Управление OBS WebSocket/секретами в core.
Иконки core нейтральные. Без плагина core не открывает игровые порты/историю и
не запускает worker. `core/boundary.test.ts` проверяет физическое отделение.

Плагин уже содержит:

- verified API2 `--worker` на существующем IPC v1;
- GSI 127.0.0.1:3665 только после явного включения;
- strict projection items/stash/couriers, включая пустые слоты;
- реальные shared ability/item algorithms, включая Techies Blast Off;
- demo/bots audio без требования OBS/сессии; session lifecycle отдельно;
- настоящие SQLite facade/detector/watchdog/session/rating/outbox/receipts;
- manual prepare/проверяемый backup, сохраняемый при повторе;
- собственные sounds UI/catalog/bindings/import/preview/master volume/history edits;
- OBS semantic policy/reconnect/config/manual/missing-scene recovery;
- независимый существующий overlay renderer, assets и HTTP/SSE на 3666;
- реальные visibility/summary controls и package-owned native hotkey;
- полноценный прежний редактор layout/queue с оригинальными form tests;
- managed image import через native picker, PNG/JPEG/WebP, два фиксированных
  существующих image roles, никаких iframe filesystem paths;
- background account/corrections/outbox через один bounded CoreRead HTTP slot;
- background layout/queue/OpenDota/quiz reads, без ожидания сети в GSI;
- durable quiz enter/leave и geometry outbox без fake game session;
- явная `chat.read`: свежий bounded public core cache, без второй Twitch/TTS очереди.

Подробнее история проверок/решений:
`docs/research/standalone-companion-extraction.md`.
Его ранние разделы — checkpoints, а не актуальный список TODO; читать последние.

## 4. Важные подтверждённые исправления и гарантии

### Audio

Rust Payload уже skip_serializing_if(None) для speech; гипотеза о null speech,
блокирующем обычный WAV, **не подтвердилась**. Не выдавать её за root cause.
Подтвердилось, что одна frontend очередь могла ждать Silero и задерживать WAV.
Теперь в том же managed transport media lane (2 pending) и speech lane
(1 pending), общий registry/fence, Twitch/TTS не изменены. Late synthesis после
fence не создаёт Audio. Реальный completion/Unknown подтверждаются native ledger,
emit не означает playback success. Core master volume — общий, не chat volume.

### HTTP / locks

Background network jobs не удерживают IPC mutex. UI HTTP тоже не удерживает его
на время сети; один UI HTTP admission guard/worker. Stop после native exit
освобождает Runtime mutex до drain UI IO. Timeout оставляет Draining. Already
admitted HTTP может записать фактический receipt в Draining, новых допусков нет.
История и произвольные SQL не доступны iframe. UI PUT сохраняет actual response;
Unknown не повторяется write, reconcile делает только signed GET того же ресурса.

### GSI

В CI выявлена гонка: rejected счётчик был виден раньше last_error. Публикация
теперь error → Release counter, status Acquire. Admission фиксируется **до ACK**,
чтобы ответ HTTP перед включением не превратился в fresh admitted frame.
Listener тот же, raw GSI и персональные поля не пишутся в логи.

### Quiz geometry

Origin/round/options/payload проверяются локальным overlay server, queue <=4,
HTTP threads не открывают SQLite. HTTP202 означает **recorded durable outbox ID**,
не доставку. Existing worker записывает geometry+outbox+receipt одной транзакцией.
Actual PUT идёт в прежний `/stream/companion/quiz/geometry`; ok/applied результат
проверяется. `applied:false` — обработанный stale round, не применённая геометрия.

Unknown geometry не retry, не разрешает новые координаты того же uncertain round.
На admission next_attempt фиксируется в дальнее будущее, чтобы crash до reply не
вызвал повтор. Fresh actual quiz/state может **отклонить как expired** старые round
records: backend UPDATE требует exact owned active round. Это не success proof.
Ключи и Unknown не удаляются. Обычные sync/events сохраняют свою проверенную
server event-UUID idempotency/retry семантику. Не ослабить эту границу при доработке.

### Ledger / quotas

Core generic transport: 10000 keys /32MiB; ordered audio/speech/scene sources,
watermarks и bounded compaction terminal records (последние256/source retained).
Старые ключи не переисполняются по watermark. Unknown/queued/unordered не удаляются.
History ledger индексированный, реальный writer один, telemetry rolling tickets.
Новая geometry/quiz нагрузка требует включения в финальную оценку общего бюджета;
последний успешный CI был ДО этих изменений.

### Native Windows root supervision

Host root Job создаётся до первого WebView. Проверка BrowserProcessId идёт через
реальный WebView2 COM и native process handle + IsProcessInJob, не PID alone.
Durable generation journal, exit proof и отказ takeover при неопределённости.
Stock updater сохранён; quiesce/fence/root retirement выполняются до stock install.
Нельзя заменить actual containment проверку timeout/PID/cache или developer bypass.

## 5. Проверки — точно что прошло

### Успешный Windows CI (проверен при передаче)

https://github.com/BaranovRoman/prereborn-companion/actions/runs/38920521889

Conclusion: **success**. Source **`5b162c8`** (проверить headSha по GitHub при
продолжении). validation_version=0.5.94, signing_validation=false, dota_candidate=false.
Это unsigned validation metadata, **не новый релиз 0.5.94**.

Прошли Windows native supervisor, frontend, package Rust/storage, NSIS,
проверка installer contents, packaged smoke с настоящим WebView и обязательный
`Durable eight-hour transport budget (actual SQLite commits)`.
Signing/release/dota-candidate jobs были skipped. Более поздние `830630f`,
`44b373a` и незакоммиченный HeroStatistics **НЕ покрыты этим успешным run**.

Лог при передаче запрашивался в
`/tmp/companion-5b162c8-windows-success.log`; сначала убедиться, что загрузка
завершилась. Из него взять точные workload metrics для окончательного отчёта.
Не запускать повторно workload только ради ожидания — предыдущий run уже завершён.

### Последние локальные целевые проверки

- `HeroStatistics/App/overlayApi`: **22 passed** (3files),
  `/tmp/dota-hero-host-ui-tests.log`.
- `dota-ui tsc --noEmit`: pass, `/tmp/dota-hero-stats-ts.log`.
- Native readonly resource cache ACK: **1 passed**,
  `/tmp/companion-resource-cache-ack-tests.log`.
- Real history hero read/error: **1 passed**,
  `/tmp/dota-hero-history-read-tests.log`.
- Worker selected tests: **12 passed** до последнего small ACK helper,
  `/tmp/dota-hero-host-worker-tests.log`.
- Sync bookkeeping/quiz geometry: **5 passed**, real temp SQLite,
  `/tmp/dota-quiz-geometry-outbox-tests.log`.
- Geometry real loopback HTTP: **1 passed**,
  `/tmp/dota-quiz-geometry-http-tests.log`.
- Package cargo check: pass, `/tmp/dota-quiz-geometry-worker-check.log` и
  `/tmp/dota-hero-stats-check.log`.
- Chat public projection / core account expiry / worker capability expiry:
  по1 target pass, `/tmp/plugin-chat-projection-tests.log`,
  `/tmp/companion-chat-cache-tests.log`, `/tmp/dota-chat-grant-tests.log`.
- Signed backend path/query tests: **3 passed**,
  `/tmp/plugin-backend-signed-routes-tests.log`.
- Actual HTTP numeric template: **1 passed**,
  `/tmp/companion-backend-template-test.log`.
- Audio lanes + actual Twitch hook: **31 passed**,
  `/tmp/companion-audio-lanes-tests.log`.
- Editor/preview controls before hero addition: **26 passed**,
  `/tmp/dota-editor-ready-tests.log`; original editor7 forms are preserved.
- `git diff --check`: pass на момент передачи.

Нет настоящего Windows user upgrade/GSI/demo/bots/Techies/audio/OBS/crash smoke
новой независимой версии. Packaged native core smoke не заменяет эти проверки.

## 6. Конкретные оставшиеся работы

### A. Завершить текущую карточку героя (малый незакоммиченный блок)

1. Просмотреть diff перечисленных файлов, особенно generic readonly ACK:
   GET может быть uncached, PUT/POST без applied:true запрещены. Тест уже есть.
2. HeroStatistics переносит реальные чистые панели из старого HeroDetailPage;
   local query = store::hero_local_stats, без скрытия ошибок под нули.
3. Избранное RMW полного queue doc сохраняет остальные поля через durable native
   PUT и показывает новое состояние только после actual receipt. UI backend
   calls сериализованы bounded queue8, чтобы stats/favorites не гонялись с native
   ui_backend single-request guard. Два новых tests проверяют no optimistic
   success/Unknown retry и сохранение local stats при OpenDota outage.
4. `Как привязать Steam` показывает инструкцию Core Settings, не обещает реально
   открыть чужой iframe route. Нет Tauri access из пакета.
5. Добавить source файлы HeroStatistics, handoff/doc checkpoint; scoped commit/push.
6. Включить изменённые тесты в следующий Windows CI и проверить весь новый source.

### B. Закрыть оставшиеся функциональные/совместимые детали перед релизом

- **Backend GSI presence/public overlay passthrough ещё НЕ перенесён.** В Worker
  нет отправки прежнего `/stream/companion/gsi-state`. Контракт читать в
  `apps/api/src/controllers/stream/companion.ts` и исходном backend 0.5.90/d9b46dd.
  Он не детектит матчи (это local-first), но сохраняет public live passthrough и
  companion presence. Нельзя молча потерять эту интеграцию или отправить auth/raw
  secrets. Переиспользовать тот же bounded CoreRead slot, typed whitelisted DTO,
  не второй writer/poller/runtime. Не переносить raw GSI JSON без фильтра.
- Проверить полный реальный backend overlay account payload: текущий worker
  account-settings может быть не полным прежним account-overlay-data документом.
  Сверить старый backend polling и renderer fields, перенести недостающие фиксированные
  публичные ресурсы, если используются. Не подменять null фиктивными данными.
- Editor reference opacity сейчас `.65` in-memory. Старая настройка
  `gameplay-reference-opacity` остаётся в main localStorage; не уничтожена, но
  ещё не перенесена через sandbox boundary. Решить минимальную безопасную
  совместимость/persistence без generic filesystem/secret доступа и нового сервиса.
- Просмотреть новый generic diagnostics IO/recovery/export, добавить необходимые
  точечные проверки; прежний rewrite пока не имеет законченной верификации.
- Migration rehearsal **на временных настоящих схемах 0.5.94 с уже сделанным
  Prepare**, включая ownership/process records, сохранность history/assets/settings,
  существующий backup. Базовые migration/parity/recovery tests есть, но не заявлять
  реальный user upgrade уже проверенным. Не запускать реальную пользовательскую БД.
- Проверить quota/headroom с **новой** quiz/geometry/backend/scene/speech нагрузкой
  в реальном восьмичасовом сценарии. Последний Windows workload не включал новые
  geometry paths. Не повышать лимиты вслепую и не удалять Unknown.
- В библиотеке metadata icon уже поддерживается, но нужен реальный package-owned
  icon и разрешённый bounded icon MIME/display путь; пока monogram fallback.
- Проверить итоговую UI интеграцию actual sandbox/renderer (source-bound readiness,
  no Tauri). Не создавать альтернативный fake preview/harness.

### C. Настоящие manifest/version/package metadata — пока НЕ готовы

`plugins/dota/manifest.windows-live.json` всё ещё **старый API1 /0.1.0**.
Его НЕЛЬЗЯ подписать и выдать за новый рабочий пакет.
Worker `plugins/dota/Cargo.toml` тоже 0.1.0; core source metadata пока0.4.0,
текущий CI подставляет validation_version. Не публиковать эти номера случайно.

При передаче через GitHub API подтверждено:

- stable Companion `prereborn-v0.5.94`:
  https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.94
- Dota `dota2-v0.1.0`:
  https://github.com/BaranovRoman/prereborn-companion-plugins/releases/tag/dota2-v0.1.0

Предполагаемые новые номера после повторной проверки latest: Companion0.5.95,
Dota0.2.0. Не перезаписывать0.1.0. API2 несовместим со старым core API1 намеренно;
каталог должен сохранить0.1.0 для старых клиентов и предлагать0.2.0 новому core.

Официальный manifest API2 должен включать реальные:

- permissions: ui, data.legacy, audio.play, obs.scene, overlay.publish,
  backend.access и chat.read (только то, что используется);
- uiCommands из actual bridge clients/worker: catalog/sound/history.hero +other
  history, OBS settings, image import/roles, overlay/hotkey, backend requests/
  pending/reconcile, audio receipt, directory picker etc.; не host.*;
- signed uiFrameOrigins `http://127.0.0.1:3666`;
- obsBindings `betweenMatches`, `draft`, `gameplay`, `postStream` с **реальными
  прежними config extension names/defaults**, сверить source; не придумать поля;
- backendResources account/corrections/sync-event, layout/queue GET+PUT, OpenDota
  favorite-heroes (camelCase heroIds)/profile-radar/hero-stats/{id}/hero-insights/{id},
  quiz-state/quiz-geometry, плюс действительно перенесённые ресурсы. Текущий лимит
  <=16 signed resources; не расширять без необходимости.
- independent UI/overlay/icon inventory с фактическими SHA256.

Core поддерживает fixed-origin signed readonly `/stream/integrations/` и строго
один canonical positive-u32 `{id}` segment; не произвольные пути/URL/secret routes.
Пакетный UI не знает backend credentials или native paths.

Обновить hardcoded0.1.0 paths в candidate workflow (около строк280), package tests,
Cargo locks/metadata и проверку reconstructed signed archive. Тесты package.py
имеют старые ожидания minApi1/maxApi1 — обновить осмысленно вместе с template,
не сломать отдельный legacy/replay fixture `plugins/dota/manifest.json`.
Не путать unit `patch(sign)` с настоящими production signatures.

### D. Финальные CI/sign/install/publication gates

После всех исправлений — scoped commit/push и новый unsigned Windows CI:

```bash
gh workflow run windows-release.yml --ref codex/plugin-runtime-prototype \
  -f validation_version=0.5.95 -f signing_validation=false -f dota_candidate=false
```

Номер использовать только после source metadata согласования. Проверить native
supervisor/process retirement, plugin IPC/storage/parity/recovery, core/UI,
NSIS byte-for-byte payload + no-game markers, actual packaged WebView containment,
и полный реальный transport/history budget. При сбое исправить, не bypass.

Затем существующий `dota_candidate=true` workflow: independent Windows x64
executable (staticCRT), real IPC tests, independent UI/overlay. Оно не публикует
само package/catalog. Использовать exact verified CI bytes и официальный
Minisign key (он отдельный от updater key, local ignored; не выводить секрет).
Existing `plugins/tools/package.py` умеет deterministic package/sign/catalog и
reconstruct signed package из exact CI input + public metadata. Existing
`verify_candidate` проверяет установку/обновление/tamper на actual manager.
Обновить его filename metadata paths под новую версию, не hardcode0.1.0.

Порядок пользователя:

1. Полный код и обязательные Windows проверки на одном проверенном source.
2. Собрать/подписать/проверить Dota package официальным key, hashes/архитектуру.
3. Опубликовать **сохранив** существующие записи подписанного каталога.
4. Проверить download, подписи и install/update реальным PluginManager; initial
   installed state выключен, без autoPrepare/автовключения.
5. Выпустить standard stable Companion, tag на exact проверенном source, existing
   updater signing/NSIS/Release/latest.json, без merge main/нового endpoint/key.
6. Проверить public artifacts, signatures, SHA256, update comparison и каталог.
7. Честный короткий checklist для реального Windows пользователя.

Updater endpoint сохранить:
`https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/latest.json`

Catalog endpoints сохранить:
`https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.json`
и соседний `catalog.minisig`.

Identifier: `com.romanbaranov.dota-companion`. Existing data paths не менять.

## 7. Что НЕ было сделано к остановке

Новый package/catalog/Companion release **НЕ опубликованы**, новых stable tags
не создано, updater key не менялся, merge не выполнялся. На Mac пользовательскую
SQLite не открывали/не мигрировали. Private signing key в source не добавлялся.
Не запускался native Mac app/Game/Windows user smoke. Нет оснований заявлять,
что новый Techies Blast Off в demo/solo bots реально проверен пользователем.

Может оставаться dev Vite на1420 (старый PTY12134), не трогать чужие процессы.
Последние проверки/commit push завершены; один read-only download CI log мог ещё
работать при создании handoff. Проверять его результат, не запускать новые build
ради самого handoff. На диске при передаче около11GiB свободно.

## 8. Уточнение после получения CI log

Read-only загрузка завершена. Source run точно:
`5b162c800983dfa842933fceb237ba6257d11a26`, conclusion success.
Лог полностью доступен в `/tmp/companion-5b162c8-windows-success.log`.

Реальный Windows transport workload: admitted15408, retained304, compacted15104,
peakReceiptBytes208527, Unknown0, pending0, processIdentities1. Время1251225ms
(~20.9min). Это ускоренная модель восьми часов с реальными admission/ACK/SQLite
commits, **не восемь часов настоящего стрима**. Match receipts измеряются отдельным
actual facade workload. Новые quiz/geometry commits этим run не проверены.

Перед остановкой `git diff --check` проходит. Handoff оставлен файлом в рабочем
дереве, без нового commit/push/CI или публикации на этапе передачи.
