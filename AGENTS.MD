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

Prefer the built-in patch/edit mechanism for normal repository changes.

- Keep edits scoped to the requested task.
- Preserve existing file encoding.
- Keep repository text files LF-only unless the file is explicitly Windows-specific.
- Do not silently continue after a partial or uncertain edit.
- Do not use large reusable custom editing frameworks for ordinary work.
- Do not modify unrelated files as part of an editing fallback.

### Windows sandbox/helper failures

Errors such as `helper_unknown_error`, `setup refresh had errors`, sandbox helper timeouts/failures, `apply_patch` infrastructure failures, and commands blocked by the Codex sandbox rather than the project are infrastructure failures, not application defects.

#### Retry policy

For the same operation:

1. Retry the standard method at most once.
2. If the error repeats, do not retry indefinitely.
3. Switch to an allowed deterministic fallback.

Do not restart the workstream or automatically ask the user to restart Codex solely because of a sandbox/helper failure.

#### Allowed fallbacks

If built-in patch/edit is unavailable:

- use safe direct editing through an available shell, Python, Node.js, or a script;
- read the current file before overwriting it;
- change only the target section;
- preserve line endings and encoding;
- inspect the diff afterward.

If Git Bash temporarily cannot start because of the sandbox, `cmd.exe` or another available shell may be used for simple read-only, Git, or file operations. Outside Git Bash use `pnpm.cmd`; never change PowerShell ExecutionPolicy. Using another shell after an infrastructure failure is not a workflow violation.

#### File operations

Deterministic Python/Node/script editing is allowed only when the exact file and expected replacement are known, current contents were checked, unknown sections are untouched, and the diff is checked afterward. Do not perform broad regex rewrites across the repository without inspection. LF/CRLF mismatch alone is not unrecoverable; repository text remains LF-only unless explicitly Windows-specific.

#### Git safety

Infrastructure failure is not grounds to stop when Git state can be checked. Before a potentially risky fallback:

- check `git status` when Git is available;
- never delete or overwrite uncommitted user changes;
- never run `git reset --hard`, `git clean -fd`, check out unrelated files, or perform other destructive operations;
- do not switch or recreate a branch when current work could be lost.

If Git is temporarily unavailable only because of the helper, safe read/edit work may continue while commit/push is deferred until Git recovers.

#### When to stop

Stop only when current file contents cannot be determined before editing, unknown uncommitted changes might be overwritten, the current branch cannot be safely determined before destructive Git work, a fallback requires guessing, all safe read/edit methods are unavailable, or data loss is possible. `helper_unknown_error` and `setup refresh had errors` alone are not sufficient reasons.

#### Validation in a degraded environment

Run every available check. Do not count a sandbox/helper failure as a test failure. Explicitly list checks blocked by infrastructure and continue when available validation is sufficient for a safe result. If the environment recovers in the same workstream, run deferred relevant checks.

#### Reporting

Do not tell the user to restart Codex and ask to continue while a safe fallback remains. Briefly record the issue internally, apply the fallback, and continue. Ask the user to intervene only when safe continuation is genuinely impossible.

#### Pet project policy

This pet project operates in build-first mode. Priorities are:

1. Preserve existing changes.
2. Complete the task correctly.
3. Use a reasonable deterministic fallback.
4. Do not turn sandbox instability into a persistent blocker.

Excessively stopping work because of tooling instability is undesirable.

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

Do not reset, discard, overwrite, or otherwise modify unrelated user changes.

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

### Shell and infrastructure failures

Do not treat shell/tooling failures as application failures. These include PowerShell ExecutionPolicy, Windows sandbox/helper errors, quoting or path syntax problems, unavailable command shims, and PATH issues.

If a command fails because of shell syntax, PATH, quoting, or a `.ps1` shim, retry with Git Bash when possible. If Git Bash is unavailable, use an allowed fallback shell under the rules above. Do not modify product logic to work around infrastructure failures.

### Long-running commands

Some repository checks may take a long time.

When a build, test, lint, typecheck, or other validation command is still running:

- do not treat a slow command as a failed command;
- wait for the result when it is required to validate the current change;
- do not restart the same command solely because it is taking longer than expected;
- do not start unrelated edits while required validation is still running;
- if the command was launched through the wrong shell or blocked by a `.ps1` shim, restart it once using Git Bash or the appropriate `.cmd` shim.
- after a timeout, run a trivial health check such as `echo` and `git status` before continuing;
- if trivial checks also fail before execution, treat it as a sandbox-wide failure and stop;
- never use broad `taskkill` or `Stop-Process` commands that may terminate unrelated user Node processes;
- do not run `pnpm install` unless dependency installation is actually required.

### Workflow continuity

Infrastructure failures interrupt only the affected operation, not the workstream. Preserve the branch, working-tree changes, completed discovery, ticket workflow actions, and successful validation. Recover only the failed operation, verify what can be verified safely, and continue.

When a safe fallback exists:

1. Preserve branch and repository state.
2. Preserve completed discovery and Weeek/GitHub steps.
3. Retry or fall back only for the failed operation.
4. Verify with available checks and run deferred checks after recovery.
5. Continue from the current workstream state.

Do not recreate a branch solely because of sandbox failure, restart completed discovery, move Weeek tasks backwards, or abandon work solely because the preferred patch or shell is unavailable.

### General implementation workflow

For implementation tasks:

1. Read the relevant instructions and ticket requirements.
2. Inspect the current repository state before editing.
3. Preserve already completed work from the current workstream.
4. Make the smallest scoped changes that satisfy the requirements.
5. Inspect the resulting diff.
6. Run `git diff --check`.
7. Run relevant targeted validation.
8. Run broader validation when required by the ticket/workflow.
9. Perform the requested self-review.
10. Fix real correctness, regression, persistence, or safety issues found during self-review.
11. Do not make unrelated cosmetic changes during final review.
12. Do not confuse infrastructure failures with product defects.

If manual UAT is explicitly deferred for the current workstream, automated validation and self-review may proceed to the configured pre-manual-review workflow gate without waiting for manual verification.