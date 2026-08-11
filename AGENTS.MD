## Development environment

This project is developed on Windows.

### Primary shell

Use Git Bash as the primary shell for all normal repository work.

Rules:

- Prefer bash-compatible commands.
- Prefer repository-relative POSIX-style paths.
- Do not use PowerShell for ordinary repository operations when Git Bash is sufficient.
- Prefer `cat`, `sed`, `grep`/`rg`, `find`, `git`, and other Git Bash-compatible tools.
- Prefer repository-relative paths over absolute Windows paths.
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

Prefer the built-in patch/edit mechanism for repository changes.

Normal editing rules:

- Preserve existing file encoding.
- Keep repository text files LF-only unless the file is explicitly Windows-specific.
- Keep edits scoped to the requested task.
- Do not silently continue after a partial or uncertain edit.
- Do not use large reusable PowerShell editing helpers such as `Replace-Exact`, `ReadAllText` / `WriteAllText` frameworks, or equivalent custom patch systems for normal work.

### Windows sandbox / apply_patch failures

The Codex App on Windows may fail before command or patch execution because of the Windows sandbox/helper.

Examples include:

- `windows sandbox helper_unknown_error`
- sandbox/helper failure before command execution
- `setup refresh` failures
- ACL/sandbox setup failures
- built-in `apply_patch` failing before modifying files

Treat these as Codex infrastructure failures, not repository or application failures.

If a normal read-only command fails before execution because of the Windows sandbox/helper:

1. Retry the same operation once.
2. Prefer Git Bash-compatible execution for the retry when applicable.
3. If the second attempt fails for the same infrastructure reason, report the failure clearly.
4. Do not modify application code to work around an infrastructure failure.

If the built-in patch/edit mechanism fails because of a Windows sandbox/helper error:

1. Retry the same patch once.
2. If the second attempt fails with the same infrastructure error, a deterministic fallback editing method is allowed.
3. Keep the fallback scoped strictly to the intended files and exact requested change.
4. Verify the resulting changes immediately before continuing.

Fallback editing priority:

1. Git Bash / standard repository tools.
2. A small one-off Node.js script.
3. PowerShell only when necessary.

Do not cycle through many different editing mechanisms after a sandbox failure.

Do not build reusable custom patch frameworks as a workaround.

After any fallback edit, always run:

- `git diff --check`
- `git diff`

Then run the relevant targeted tests, typecheck, lint, or build before considering the change complete.

If a fallback edit partially succeeds or its result cannot be verified, stop and report it instead of attempting to repair the state blindly.

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

- inspect `git status`
- inspect the final diff
- run `git diff --check`
- run the relevant validation commands

Do not reset, discard, or overwrite unrelated user changes.

When the user explicitly asks to push a branch, create a pull request, or complete a workflow that includes those actions, that request authorizes pushing the current task branch to the repository's configured `origin` and creating or updating the requested pull request without an additional confirmation prompt.

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

- use PowerShell deliberately
- keep the Windows-specific scope as small as possible
- use `.cmd` shims for Node tooling where appropriate
- do not broaden PowerShell usage to ordinary repository work

### Shell failures

Do not treat shell/tooling failures as application failures.

Examples of environment failures:

- PowerShell ExecutionPolicy
- sandbox/helper errors
- shell quoting problems
- path syntax problems
- unavailable command shim
- PATH issues

If the command process starts and then fails because of shell syntax, PATH, quoting, or a `.ps1` shim, retry using Git Bash when possible.

If the failure happens before the command starts because of the Codex Windows sandbox/helper, follow the Windows sandbox rules above.

Do not modify application code to work around shell or infrastructure problems.

### Long-running commands

Some repository checks may take a long time.

When a build, test, lint, typecheck, or other validation command is still running:

- do not start unrelated edits in parallel
- wait for the result when that result is required to validate the current change
- distinguish a slow command from a failed command
- do not restart the same command solely because it is taking longer than expected
- if the command was launched through the wrong shell or blocked by a `.ps1` shim, restart it once using the correct Git Bash command or `.cmd` shim

### General workflow

For implementation tasks:

1. Read the relevant instructions and task requirements.
2. Inspect the current repository state before editing.
3. Make the smallest scoped change that satisfies the task.
4. Inspect the diff.
5. Run `git diff --check`.
6. Run relevant targeted validation.
7. Run broader validation only when appropriate.
8. Do not confuse infrastructure failures with product defects.
9. Do not abandon an otherwise valid workstream solely because the Windows sandbox temporarily blocks the built-in editor; use the controlled fallback rules above.
