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

### Windows sandbox / apply_patch failures

The Codex App on Windows may intermittently fail before command or patch execution because of the Windows sandbox/helper.

Examples include:

- `windows sandbox helper_unknown_error`
- sandbox/helper failure before command execution
- `setup refresh` failures
- ACL/sandbox setup failures
- built-in `apply_patch` failing before modifying files

Treat these as Codex infrastructure failures, not repository or application failures.

#### Read-only command failures

If a normal read-only command fails before execution because of the Windows sandbox/helper:

1. Retry the same operation once.
2. Prefer an equivalent Git Bash-compatible command for the retry when applicable.
3. If the retry also fails for the same infrastructure reason, report the failure if the requested information cannot otherwise be obtained safely.
4. Do not modify application code to work around the infrastructure failure.

#### File editing failures

If the built-in patch/edit mechanism fails because of a Windows sandbox/helper error:

1. Retry the same patch once.
2. If the second attempt fails with the same infrastructure error, fallback editing is explicitly allowed.
3. Use the smallest deterministic fallback available.
4. Keep the fallback strictly limited to the intended files and requested changes.
5. Verify the resulting diff immediately before continuing.

Fallback editing priority:

1. Git Bash / standard repository tools.
2. A small one-off Node.js script.
3. `git apply` with a generated patch.
4. PowerShell only when the previous options are impractical.

Do not stop an otherwise valid workstream solely because the built-in patch/edit mechanism is unavailable.

Do not cycle through many different editing mechanisms. Once a deterministic fallback works, continue with that mechanism for the current edit.

Do not create reusable custom editing frameworks such as large `Replace-Exact`, `ReadAllText` / `WriteAllText`, or similar helpers unless there is no simpler deterministic option.

After every fallback edit, always run:

- `git diff --check`
- `git diff`

Inspect the resulting diff before continuing.

Then run the relevant targeted tests, typecheck, lint, or build required to validate the affected code.

If a fallback edit:

- partially succeeds;
- produces an unexpected diff;
- modifies unrelated files;
- cannot be verified reliably;

stop and report the exact repository state instead of attempting blind repairs.

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

Do not treat shell/tooling failures as application failures.

Examples of environment failures include:

- PowerShell ExecutionPolicy
- Windows sandbox/helper errors
- shell quoting problems
- path syntax problems
- unavailable command shims
- PATH issues

If a command starts and then fails because of shell syntax, PATH, quoting, or a `.ps1` shim, retry using Git Bash when possible.

If a command or patch fails before execution because of the Codex Windows sandbox/helper, follow the dedicated Windows sandbox rules above.

Infrastructure failures must not automatically terminate a valid ticket workstream when a deterministic and verifiable fallback is available.

Do not modify product logic to work around shell or infrastructure failures.

### Long-running commands

Some repository checks may take a long time.

When a build, test, lint, typecheck, or other validation command is still running:

- do not treat a slow command as a failed command;
- wait for the result when it is required to validate the current change;
- do not restart the same command solely because it is taking longer than expected;
- do not start unrelated edits while required validation is still running;
- if the command was launched through the wrong shell or blocked by a `.ps1` shim, restart it once using Git Bash or the appropriate `.cmd` shim.

### Workflow continuity

Infrastructure failures should interrupt only the affected operation, not automatically abandon the entire ticket workstream.

When a safe fallback is available:

1. preserve the current branch and repository state;
2. preserve completed discovery and analysis;
3. preserve already completed Weeek/GitHub workflow steps;
4. retry or fall back only for the failed operation;
5. verify the result;
6. continue from the current workstream state.

Do not:

- recreate a branch solely because of a sandbox failure;
- restart completed ticket discovery without a reason;
- move Weeek tasks backwards because of an infrastructure failure;
- abandon a workstream solely because built-in `apply_patch` is unavailable.

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