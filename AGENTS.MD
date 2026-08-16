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

## Research workflow

Research/discovery/audit tasks must leave a durable result in `docs/research/<topic>.md`,
not only in an AI chat or a PR description — see
[docs/research/README.md](docs/research/README.md) for the required structure and rules.

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
