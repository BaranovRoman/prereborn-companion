# Stable Windows update 0.5.91 — preparation

## Question
Подготовить обычное обновление всех текущих Windows stable пользователей без RC канала,
автоматической External activation, пользовательской SQLite migration и неподготовленного package.

## Current state
Проверено GitHub API / штатный updater endpoint 2026-10-13:
- Latest non-prerelease: prereborn-v0.5.90, опубликован 2026-10-09 17:47:30 UTC.
- Commit 58ad91e5245f205562d0381b92a678884240d628 — ancestor feature HEAD.
- Windows stable workflow run 37965840190 успешен; main build 37965812203 успешен.
- latest.json.version=0.5.90; windows-x86_64 URL ведёт к installer 24 714 080 bytes.
- SHA256 installer: 237a7c9afe85d7523d955e5c1b952bc70819104b14f30afcdeed9ae5faedf30a.
- Tag/release 0.5.91 отсутствует на момент проверки. Следующий patch: 0.5.91; не prerelease.
- Установленная Windows-версия подтверждена пользователем: **0.5.89**.
  Её updater 2.10.1, key, endpoint и весь tauri.conf.json совпадают с feature; 0.5.91 > 0.5.89.
  Source version 0.4.0 не означает installed/published version: CI stamp из tag меняет три metadata.

## Findings
### Update channel and trust
Endpoint/public key/app identifier сохранены. No version comparator override:
actual tauri-plugin-updater 2.10.1 uses semver remote.version > package_info.version.
Key configuration присутствует в истории prereborn-v0.5.0 onward.
Опубликованный 0.5.90 installer скачан в /tmp и криптографически проверен configured updater
key через minisign-verify, плюс SHA256, manifest/sidecar signature и URL/version.
Изменённый байт installer отклонён invalid_signature; equal-version отклонён actual RemoteRelease
SemVer comparison. Проверка новой 0.5.91 подписи пока pending до разрешённого signing run.

UI check происходит на mount или по кнопке; постоянно открытое приложение не имеет background
polling. Новая версия предлагается при следующем check. Windows x64 stable 0.5.x с этим updater
и key получают 0.5.91; исторические версии до наличия updater нельзя обновить через отсутствующий
механизм. Недоступный GitHub/прокси/firewall/изменённый trust key остаются внешними ограничениями.

Найден преждевременный ready: native plugin sends Finished BEFORE signature verification.
UI исправлен: ready только после successful downloadAndInstall; error не означает installed.
При Windows install native plugin запускает NSIS /UPDATE и завершает приложение; пользователю
не нужно вручную скачивать/запускать NSIS. pending metadata очищается перед новой проверкой.

### Release preparation
RC job/inputs удалены. Существующий windows-release.yml:
1. Manual validation_version=0.5.91, signing_validation=false — обычный build-windows, без secrets,
   native supervisor tests, keyring smoke, NSIS metadata/payload inventory и existing GSI/overlay smoke.
2. **Только после отдельного разрешения:** тот же workflow, signing_validation=true на feature ref:
   existing release-windows build/sign pipeline, manifest/signature/sha verification, Actions artifact;
   GitHub Release/deploy steps skipped on branch. Это dry-run workflow, не update channel.
3. **После проверки signed artifacts и отдельного разрешения публикации:** stable tag prereborn-v0.5.91
   на согласованном SHA; existing pipeline выпускает GitHub Release/latest.json, updater предлагает версию.
   Merge в main не выполняется автоматически и не является техническим требованием tag build.

Stable tags ограничены X.Y.Z, metadata version stamped в package.json/tauri.conf.json/Cargo.toml.
Release job serialized, перед публикацией сравнивает новую version с живым stable latest.json,
проверяет signature действующим public key, digest/URL/sidecar и installer payload hash/version.
Старая проверка assets presence сохранена. Signed artifacts не публикуются до разрешения.

Неподготовленный Dota worker/package не собирается и не включается в stable release.
7-Zip NSIS inventory reject отдельного worker/package/private key; extracted app должен совпасть
с проверенным binary по hash/version. BuiltIn Dota/domain/UI/sounds/overlay остаются в core.
Отдельный live package/catalog в этот выпуск не входит.

### Changes vs 0.5.90
Все согласованные migration iterations: core/Dota boundaries, общий dota-domain, Plugin Runtime/
Manager/store UI, read-only APIs, facade и dormant ownership/ledger/receipt/external execution paths,
Windows job supervision. BuiltIn остаётся default; installed Dota activation/developer gate closed;
нет automatic production migration/External worker. В дополнение — updater UI receipt timing fix
и усиленная проверка stable artifacts. Feature branch включает stable 0.5.90, не удаляет её fixes.

## Options
RC канал отвергнут по прямому требованию. Используется только действующий stable endpoint/key.
Signing rehearsal без публикации нужен для проверки новых подписанных bytes до воздействия на
пользователей; new tag сразу запускает signing + publish и поэтому пока НЕ создаётся.

## Recommendation
0.5.91 через стандартный updater после unsigned Windows CI, signing rehearsal и native update
compatibility checks. Не обещать end-to-end upgrade всех пользователей до проверки подписанного
installer: unsigned CI не проверяет новую подпись или фактический upgrade текущей Windows установки.
Временные SQLite только; реальные БД/.gitignore не изменяются.

## Follow-up
- Installed Windows version: 0.5.89, подтверждена; metadata/key/endpoint сверены с tag.
- Пользователь явно разрешил push + unsigned CI; a873b54 отправлен, run 38422658969.
  release-windows skipped. Первый run failed: combined Rust lib-test не загрузился,
  STATUS_ENTRYPOINT_NOT_FOUND, до тестов/installer. Известный framework test-harness loader
  issue также описан existing keyring_smoke example; не считается успешной проверкой продукта.
  OS-тесты переведены в точечный integration target с exact production windows.rs (без копии
  реализации/нового runtime/mock OS); Повторный run 38423838859 загрузил native target и выявил гонку:
  ActiveProcesses=0 раньше signal process handle; 2 tests passed / 2 failed. Исправлен production
  fencing: bounded authoritative job-membership capture, OpenProcess+IsProcessInJob, ожидание
  captured kernel handles и отказ при изменении TotalProcesses. Owned Child сохраняет witness
  при stop; counter=0 отдельно не доказывает exit. Добавлен настоящий descendant-tree test
  с синхронизацией готовности OS-процессов; следующий unsigned run pending. Durable journal Mac tests
  passed; Windows journal/lifecycle combined lib-test не выполнены и не объявляются passed.
- Signing rehearsal/новые updater signatures: требуется отдельное разрешение.
- Native 0.5.90 → 0.5.91 NSIS /UPDATE, история/settings/credentials/Twitch/TTS/OBS/реальный GSI:
  manual pending. Полный check через живой latest endpoint возможен после публикации;
  до неё signature/semver/installer upgrade проверяются раздельно, endpoint не подменяется.
- После всех обязательных проверок получить явное разрешение stable publication; не merge автоматически.

## Sources
- https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.90
- https://github.com/BaranovRoman/prereborn-companion/actions/runs/37965840190
- https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/latest.json
- Local actual SDK source: tauri-plugin-updater-2.10.1/src/updater.rs (SemVer, verification, NSIS install),
  commands.rs (Finished before verification).
- .github/workflows/windows-release.yml; tauri.conf.json; useUpdater.ts; AppShell.tsx;
  scripts/companion-generate-update-manifest.ps1 / companion-verify-release-assets.ps1.

## Local validation
3 targeted updater Vitest tests passed; TypeScript passed. Published 0.5.90 installer configured-key
signature/hash/URL verified; tampered binary rejected, equal-version rejected. Actual SDK RemoteRelease
SemVer unit test checks 0.5.91 > 0.5.9/0.5.89/0.5.90 and no equal/newer offer. Release contract guard,
workflow YAML/embedded Python and git diff --check passed. Windows PS scripts/7-Zip inventory/native
supervision/new installer/signature/manual upgrade остаются pending Windows CI/разрешений.
