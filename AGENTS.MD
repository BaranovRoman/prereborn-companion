## Development environment

This project is developed on Windows.

### Primary shell

Use Git Bash as the primary shell for all normal repository work.

- Prefer bash-compatible commands.
- Prefer repository-relative POSIX-style paths.
- Prefer repository-relative paths over absolute Windows paths.
- Do not use PowerShell for ordinary repository operations when Git Bash is sufficient.
- Do not use `Get-Content`, `Select-Object`, `Get-ChildItem`, or other PowerShell equivalents when a standard bash command is sufficient.
- Prefer `cat`, `sed`, `grep`/`rg`, `find`, `git`, and other Git Bash-compatible tools.
- Do not switch shells repeatedly unless the failure is clearly shell-specific.

### Node.js / pnpm

Use pnpm for workspace commands.

When running in Git Bash, use:

- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm exec ...`

Do not invoke `pnpm.ps1`.

If execution happens through PowerShell for an unavoidable Windows-specific task, invoke the Windows command shim explicitly:

- `pnpm.cmd`
- `npm.cmd`
- `npx.cmd`

Do not change Windows ExecutionPolicy just to run repository commands or checks.

A PowerShell ExecutionPolicy failure is an environment/shell issue, not an application failure.

### File editing

- Keep edits scoped to the requested task.
- Preserve existing file encoding.
- Keep repository text files LF-only unless the file is explicitly Windows-specific.
- Do not silently continue after a partial or uncertain edit.
- Do not use large reusable custom editing frameworks for ordinary work.
- Do not modify unrelated files as part of an editing fallback.

### Git

Use Git for Windows / Git Bash for normal Git operations.

Prefer:

- `git status`
- `git diff`
- `git diff --check`
- `git apply`
- `git grep`
- `git log`
- `git show`

Do not replace normal Git operations with PowerShell scripts.

Before committing:

- inspect `git status`;
- inspect the final diff;
- run `git diff --check`;
- run the relevant validation commands.

Protecting existing work:

- Check `git status` before any operation that could discard uncommitted changes (checkout/restore/reset/clean, etc.).
- Never delete or overwrite uncommitted user changes.
- Never run `git reset --hard`, `git clean -fd`, force-push, or other destructive/history-rewriting operations unless explicitly requested.
- Do not switch or recreate a branch when current work on it could be lost.
- Do not reset, discard, overwrite, or otherwise modify unrelated user changes.

### Windows-specific operations

PowerShell is allowed when the operation genuinely requires Windows, for example:

- Tauri Windows packaging
- `.ps1` scripts already maintained by the repository
- Windows process/service management
- OBS integration
- Windows APIs
- registry operations
- Windows-specific diagnostics

For these cases:

- use PowerShell deliberately;
- keep the Windows-specific scope as small as possible;
- use `.cmd` shims for Node tooling where appropriate;
- do not broaden PowerShell usage to ordinary repository work.

### Shell and tooling issues

Do not treat shell/tooling failures as application failures. These include PowerShell ExecutionPolicy errors, quoting or path syntax problems, unavailable command shims, and PATH issues.

If a command fails because of shell syntax, PATH, quoting, or a `.ps1` shim, retry with Git Bash when possible. Do not modify product logic to work around a shell/tooling failure.

### Long-running commands

Some repository checks may take a long time.

When a build, test, lint, typecheck, or other validation command is still running:

- do not treat a slow command as a failed command;
- wait for the result when it is required to validate the current change;
- do not restart the same command solely because it is taking longer than expected;
- do not start unrelated edits while required validation is still running;
- if the command was launched through the wrong shell or blocked by a `.ps1` shim, restart it once using Git Bash or the appropriate `.cmd` shim;
- never use broad `taskkill` or `Stop-Process` commands that may terminate unrelated user Node processes;
- do not run `pnpm install` unless dependency installation is actually required.

### Build-first workflow

This is a pet project operating in build-first mode. Priorities, in order:

1. Preserve existing changes.
2. Complete the task correctly.
3. Use a reasonable deterministic fallback rather than stopping outright over routine tooling friction.
4. Do not turn ordinary tooling instability into a persistent blocker.

Stop and ask the user only when current file/branch state cannot be safely determined before an edit, uncommitted changes could be lost, or continuing would require guessing.

### Implementation workflow

For implementation tasks:

1. Read the relevant instructions and ticket requirements.
2. Inspect the current repository state before editing.
3. Preserve already completed work from the current session.
4. Make the smallest scoped changes that satisfy the requirements.
5. Inspect the resulting diff and run `git diff --check`.
6. Run relevant targeted validation, then broader validation when required by the workflow.
7. Perform a self-review; fix real correctness, regression, persistence, or safety issues found.
8. Do not make unrelated cosmetic changes during final review.

If manual UAT is explicitly deferred for the current workstream, automated validation and self-review may proceed to the configured pre-manual-review workflow gate without waiting for manual verification.

## Ticket → Release (default task lifecycle)

По умолчанию завершение реализации тикета включает полный production-релиз.

Стандартный жизненный цикл задачи:

Ticket → Implementation → Tests → CI → Production Release → Production Verification → Report.

Создание коммита, PR или успешное прохождение тестов не считается завершением задачи.

После реализации тикета агент самостоятельно:

- выполняет тесты и необходимые проверки;
- исправляет обнаруженные проблемы;
- развёртывает backend/API первым, если изменения требуют этого;
- выпускает stable Companion через штатный подписанный updater, если изменён Companion;
- публикует совместимые пакеты и каталог плагинов, если изменены плагины;
- проверяет опубликованные артефакты и доступность обновлений;
- обновляет статус тикета и прикладывает ссылки на PR, CI и релиз;
- предоставляет краткий отчёт с результатами и инструкцией для пользовательской проверки на production.

Отдельное подтверждение на публикацию релиза не требуется. Пользователь заранее разрешает
production-релизы в рамках реализации тикетов.

Если тикет затрагивает только API, не нужно искусственно выпускать новую версию Companion. Если
меняется только плагин, достаточно релиза плагина и обновления каталога, если это поддерживается
архитектурой.

Версионирование должно соответствовать SemVer:

- patch — исправления;
- minor — новая функциональность;
- major — несовместимые изменения после стабилизации публичного API;
- для версий 0.x архитектурные изменения оформляются как minor, а не маскируются patch.

Не публиковать релиз при проваленных обязательных проверках, неподтверждённых миграциях или
известной критической регрессии.

Автоматические проверки не заменяют ручную приёмку. После релиза задача получает статус ожидания
пользовательской проверки, если такая стадия существует. Не объявлять функциональность проверенной
на реальном Twitch, OBS или Dota без соответствующего тестирования.

Если пользователь явно попросил не публиковать релиз для конкретной задачи, это указание имеет
приоритет.

Это правило не отменяет механизмы разрешений среды выполнения: если инструмент или среда требуют
отдельного подтверждения на деплой, публикацию или изменение инструкций, запросить его штатным
способом, а не обходить ограничение.

### How releases actually ship here (verified 2026-10-21)

- **Branches.** Companion work and releases live on `codex/plugin-runtime-prototype`; `main` is far
  behind it. Branch tickets off the release branch and target PRs there. Do not merge the release
  branch into `main` wholesale.
- **API/web → production.** `deploy-production.yml` deploys only a CI-verified commit on `main`
  (on CI success, or on the `companion-released` dispatch). So API/web changes reach production
  only by landing on `main`: put just those `apps/api`/`apps/web` changes on a branch from
  `origin/main`, open a PR to `main`, merge once CI passes, and wait for the deploy. First check
  that `git diff origin/main <release-branch> -- apps/api apps/web` contains nothing else.
  Verify with `curl https://prereborn.ru/api/health`: `releaseSha` must be the new `main` commit.
  Deploy the API before the Companion release that depends on it.
- **Companion → users.** Push a stable `prereborn-vX.Y.Z` tag on the release branch.
  `windows-release.yml` takes the version from the tag, builds, signs, publishes the GitHub Release
  and `latest.json`, and verifies the assets. Before choosing the version, read the current
  production version from
  `https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/latest.json`
  and the existing tags. Never publish a test NSIS, RC or validation build in place of a stable
  release.
- **Weeek.** The project has no PR/МР custom field, so writing the MR link fails. Put the PR, CI and
  release links in the report instead.

## Research workflow

Research/discovery/audit tasks must leave a durable result in `docs/research/<topic>.md`,
not only in an AI chat or a PR description — see
[docs/research/README.md](docs/research/README.md) for the required structure and rules.

## Production environment variables

Production `.env` is fully regenerated from `.github/workflows/deploy-production.yml`
on every deploy — nothing added only to `.env.example` reaches the server. When adding
a new production env variable, an agent must:

1. Update `.env.example` (and `env.production.example` if it differs for production).
2. Classify it as required / optional / secret.
3. Wire it into `deploy-production.yml` (and a fail-fast check in `apps/api/src/config/env.ts`
   if required) so it actually reaches production.
4. Not assume a developer will manually SSH in and add it to the server after merge.

Full details: [docs/operations/production-env.md](docs/operations/production-env.md).

## Codebase navigation

Graphify (`graphify-mcp`) is available as an MCP server exposing this repository as a code
knowledge graph (symbols, calls, imports, routes → controllers → services). It is a map for
navigation, not a replacement for reading source. Setup: [docs/graphify-setup.md](docs/graphify-setup.md).

For tasks that touch existing functionality:

1. First use Graphify to locate relevant symbols/modules/routes/dependencies.
2. Then read only the files/ranges it points to.
3. Read the actual source before making any change — the graph can lag behind the working tree; source code is the source of truth when they disagree.
4. After a change, check real callers/dependents where that matters, not just the graph snapshot.

Prefer Graphify for: finding an entry point in unfamiliar code, callers/callees, dependency
and blast-radius questions, route → controller → service → storage paths, and locating
related tests.

Skip Graphify when the file is already known, the change is a small local edit, reading a
small config is enough, or a plain search/read is obviously cheaper. Request the smallest
subgraph needed for the question — never dump the whole repository graph into context.
