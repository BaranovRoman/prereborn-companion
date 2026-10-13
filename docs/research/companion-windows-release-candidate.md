# Windows Release Candidate — iteration 17

## Question
Как подготовить BuiltIn RC и доказуемое Windows process fencing без автоактивации External?

## Current state
Baseline cbf8300. Один GSI listener, BuiltIn default, production adapter/ledger/audio/OBS;
External gate закрыт, migration explicit. Mac M1, Windows native execution недоступен.
Существующий windows-release.yml: NSIS CI без secrets; tag job подписывает updater,
собирает Silero и публикует GitHub Release/deploy. Этот job не запускался.

## Findings
- Runtime использует Windows Job Object KILL_ON_JOB_CLOSE и JOB_LIST/HANDLE_LIST в
  STARTUPINFOEXW/CreateProcessW. Job назначается атомарно при spawn; нет окна suspended orphan.
  No breakaway flag, job handle не наследуется; child/descendants прекращаются при Core crash.
  Остановка подтверждается owned process handle + ActiveProcesses=0, не PID/timeout.
- Generation UUID и windows-job-list-v1 marker записываются до spawn в существующий
  checksum-protected pc_tx_owner journal. Старые записи без marker остаются unproved.
  Explicit recovery открывает только generation-named job, прекращает дерево и проверяет
  ActiveProcesses=0; отсутствие job допустимо только с записанным atomic-supervision marker.
  Ошибки/доступ/timeout fail closed. Recovery не запускается автоматически и не выдаёт lease;
  требуется отдельный audio/OBS proof и новый epoch. Recovery сериализован существующим transition lock и требует Draining/in-flight=0,
  чтобы отсутствие job не могло гоняться с новым spawn. History lock не держится во время OS wait.
- Новый optional manual candidate job в существующем registered windows-release.yml имеет contents:read, RC version только в runner checkout,
  targeted native tests, existing keyring smoke, NSIS/checksums/private Actions artifact.
  RC runner-only beforeBuildCommand делает tsc + vite, не пересобирает committed overlay renderer. Никакого release/updater/deploy. Candidate job ограничен текущей feature-веткой;
  manual candidate dispatch также запрещает tag publication. Обычные tag/push пути сохранены.
  Опциональная подписанная Dota сборка использует официальный ключ; no developer bypass.
- package.py ранее терял execution; исправлено сохранение execution и minApi/maxApi.
  Windows pnpm.cmd выбран явно. Ключ внутри UI input/output внутри UI отвергаются.
  Live manifest: IPC v1, ui/match/sound/obs/overlay, Windows x86_64; executable hashes генерируются.
- Реальный Store verifier использует shipped TRUSTED_KEY, temporary root, disabled install,
  payload tamper rejection, EXE revalidation, uninstall/reopen; ничего не запускает.
  Signing/Windows artifact/успешный Windows update не выполнены: нет разрешённого secret run.
- Production магазин требует signed catalog и GitHub URL, local-install только debug.
  Workflow release metadata URL явно неопубликован: artifact нельзя установить через магазин
  до согласованной доставки/catalog update. Каталог не изменён и не опубликован.
- Bundle config не содержит resources/externalBin для независимого Dota worker/package.
  Но compiled-in dota/local_runtime/game_sounds, игровые UI/catalog и include_str overlay renderer
  всё ещё в core. Нет физического исключения Dota кода/dependencies для пользователя без Dota.
  Это blocker финального универсального plugin-only релиза, не BuiltIn regression RC.
- identifier com.romanbaranov.dota-companion/updater endpoint/settings/data paths не менялись.
  Overinstall version нужно выбрать выше фактически установленной stable; не проверено на Windows.

## Options
1. Spawn suspended → assign job: оставляет crash gap/orphan, отклонено.
2. Rust Command spawn_with_attributes: nightly-only, отклонено.
3. Native atomic job-list spawn внутри существующего Runtime: выбран; сохраняет IPC и pipes,
   cfg(windows) replacement Child wrapper, без дополнительного процесса/протокола.

## Recommendation
BuiltIn RC собрать через manual candidate workflow после согласования candidate_version/отправки ветки.
Gate оставить закрытым: cross-check не доказывает native Windows fencing/audio/OBS.
Не обещать signed artifact или installer до успешного CI; секретный signing step требует
человеческого разрешения. Native checklist: docs/operations/companion-windows-rc-smoke.md.

## Follow-up
Windows runner + native ПК proof → подключить existing manual preflight/handover/recovery,
сначала migration на копии, затем game-only audio/OBS fencing и fresh-epoch fallback.
Нужны signed package/catalog distribution approval и реальный higher-version update.
Не требуется новый архитектурный этап. Физическое разделение Dota — отдельный оставшийся scope.

## Sources
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
- https://doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html
- Production source: core/plugin_runtime/windows.rs, local_runtime/transaction_authorization.rs,
  core/dota_live/ipc.rs, plugins/tools/package.py, plugins/manager/src/lib.rs,
  core/plugin_manager.rs, tauri.conf.json, windows-release.yml.

## Validation (macOS, iteration 17)
- Runtime: 8 passed; durable journal: 3 passed (temp SQLite reopen, legacy marker, corruption).
- Real IPC cached receipt/Unknown recovery and PID-reuse/empty-Runtime fencing: 2 passed.
- Package manager targeted install/update/uninstall, signature/archive rejection, installed-tamper: 3 passed.
- package.py serialization/secret-input rejection: 2 passed; official signing НЕ запускался.
- cargo check: affected Companion on macOS, manager candidate-verifier example, production
  windows.rs + native tests cross-check x86_64-pc-windows-msvc using existing target/cache only.
  Cross-check компилировал непосредственно production windows.rs; весь Windows Tauri crate,
  Windows linking/native execution/NSIS contents не проверены на Mac.
- Workflow YAML parsed, embedded Python compiled, permissions/secrets/publication steps inspected;
  git diff --check passed. Frontend не менялся; TS/Vitest и production bundles локально не запускались.
- CI не отправлен/не запущен; signed Windows archive/installer пока отсутствуют.
- Native Windows supervisor tests подготовлены: quoting, spawn failure, generation collision,
  job-tree termination, owner crash with captured kernel handle, pre-spawn journal recovery.
  Existing IPC lifecycle/hang tests включены в candidate workflow; доказательство pending до CI.
