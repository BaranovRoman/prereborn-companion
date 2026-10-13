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

## Windows CI follow-up
- Installed 0.5.89 confirmed; user explicitly authorized feature push/unsigned CI.
- Native OS integration tests and real Credential Manager passed on f75a8bb/336091b.
  5 OS assertions (plus 3 subprocess fixtures intentionally ignored); combined framework lib-test
  remains unsupported on runner and is not reported passed.
- App + NSIS 0.5.91 compiled successfully. First inventory gate failed because it compared
  unbundled UNK binary with the bundled NSS binary without accounting for the SDK patch.
- Run 38430730036 evidence: both executables 46,178,816 bytes; exactly 3 differing bytes
  at offsets 41,439,458..460 in .rdata, `__TAURI_BUNDLE_TYPE_VAR_UNK` -> `..._NSS`.
  Confirmed by actual tauri-utils platform.rs and official bundler bundle.rs. No code/resource
  differences otherwise. Gate now constructs only that exact expected change in memory and
  requires all remaining bytes equal; 3 Python regression tests passed, downloaded actual
  Windows evidence passed the strict verifier. No broad timestamp/PE normalization.
- Subsequent full unsigned CI still pending, including packaged GSI/overlay smoke and artifact.
- Source evidence: https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs
  and cached tauri-utils SDK platform.rs (NSS selection).

## Final unsigned Windows result
Authorized unsigned run **38432855886** completed SUCCESS on runtime/build source
**eef27f392d37ae5e4d9eaf3190046a7a0a65d314**. release-windows SKIPPED.
Passed: 5 native supervisor tests (3 explicit subprocess fixtures ignored), real Windows
Credential Manager, TypeScript/Vite + Rust release/NSIS build, PE 0.5.91 metadata, unchanged
identifier/endpoint, installer inventory with no separate Dota worker/package/private key,
strict exact UNK->NSS payload verification, packaged app startup + GSI 3665/canonical overlay
HTML/state/initial SSE, Draft/Gameplay synthetic states, second-instance rejection without
interrupting original runtime, checksums and upload.
Artifact `prereborn-companion-windows`: 25,174,805 bytes, unsigned; not an updater/public release.
https://github.com/BaranovRoman/prereborn-companion/actions/runs/38432855886

Published stable still 0.5.90 after CI, installed version 0.5.89. No signing run, merge, tag,
GitHub Release or updater publication performed. User .gitignore and real SQLite untouched.
Next permission: signing rehearsal `validation_version=0.5.91`, `signing_validation=true`
on approved feature ref, no publication. Then verify NEW configured-key signature/manifest,
installer upgrade preservation and manual Twitch/TTS/OBS/real GSI smoke. Publication remains
separate explicit permission; ordinary stable tag pipeline creates latest.json for existing endpoint.
No developer gate/External activation or auto SQLite migration.

## Authorized stable publication 0.5.91
User explicitly authorized the full stable release, with no separate signing rehearsal
and no merge. Tag `prereborn-v0.5.91` points to verified source
`bf93e39fa569e013be6ba21323426b3b933f6197`; its only difference from unsigned-tested
`eef27f3` is this research report. Existing Windows release workflow run 38436155225
passed installer metadata/inventory, packaged smoke, checksum, configured-key signature
and complete-assets gates before publishing the non-draft, non-prerelease release.

Release: https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.91
CI: https://github.com/BaranovRoman/prereborn-companion/actions/runs/38436155225
Final result: completed SUCCESS; release-windows SUCCESS, build-windows intentionally SKIPPED.

Post-publication, the unchanged public `/releases/latest/download/latest.json` endpoint
returned version 0.5.91 and the correct Windows x64 installer URL. Downloaded public
installer + signature + checksum were verified by the existing read-only verifier using
the shipped updater public key: manifest version/URL, exact signature sidecar, cryptographic
signature and SHA256 all passed. Actual updater RemoteRelease comparison against installed
0.5.89 passed. Installer SHA256:
`2227953341100339e1620158b8d9a2ee83e4283cb24c12c4e0e102754a96046b`.
Published assets contain installer/sidecars/latest.json and existing Silero assets, no
standalone Dota package/worker. BuiltIn remains default, External activation stays closed,
no automatic history migration, updater key/identifier/data paths unchanged.

0.5.89 should offer 0.5.91 on the normal updater check (launch/manual check); this is
metadata/signature/SDK evidence, not a performed real upgrade. Manual Windows checks remain:
upgrade from 0.5.89, preservation of settings/history/credentials, Twitch chat/TTS including
long messages, OBS connection/scenes/reconnect, BuiltIn Dota real GSI/sounds/draft reminder/
overlay, post-game history and restart. User SQLite and existing .gitignore were untouched.
