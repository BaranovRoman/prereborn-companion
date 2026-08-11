## Development environment

This project is developed on Windows.

### Primary shell

Use Git Bash as the primary shell for all normal repository work.

- Prefer bash-compatible commands.
- Prefer repository-relative POSIX-style paths.
- Do not use PowerShell for ordinary repository operations.
- Do not use `Get-Content`, `Select-Object`, `Get-ChildItem`, or other PowerShell equivalents when a standard bash command is sufficient.
- Prefer `cat`, `sed`, `grep`/`rg`, `find`, `git`, and other Git Bash-compatible tools.

### Node.js / pnpm

Use pnpm for workspace commands.

When running in Git Bash, use:

- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm exec ...`

Do not invoke `pnpm.ps1`.

If execution happens through PowerShell for an unavoidable Windows-specific task, invoke `pnpm.cmd` explicitly instead of `pnpm` to avoid PowerShell ExecutionPolicy issues.

Do not change Windows ExecutionPolicy just to run repository checks.

### File editing

- Prefer the built-in patch/edit mechanism.
- Do not create custom PowerShell file editing helpers using `ReadAllText`, `WriteAllText`, `Replace-Exact`, or similar.
- Do not chain multiple alternative editing mechanisms after an infrastructure/sandbox failure.
- If the built-in editing mechanism fails because of sandbox/tooling infrastructure, report the infrastructure failure clearly.
- Preserve existing file encoding.
- Keep repository text files LF-only unless the file is explicitly Windows-specific.

### Git

Use Git for Windows / Git Bash.

Prefer:

- `git status`
- `git diff`
- `git apply`
- `git grep`
- `git log`

Do not replace normal Git operations with PowerShell scripts.

### Windows-specific operations

PowerShell is allowed when the operation genuinely requires Windows, for example:

- Tauri Windows packaging
- `.ps1` scripts already maintained by the repository
- Windows process/service management
- OBS integration
- Windows APIs
- registry operations
- Windows-specific diagnostics

For these cases, use PowerShell deliberately and keep the Windows-specific scope as small as possible.

### Shell failures

Do not treat a shell/tooling failure as an application failure.

If a command fails because of:

- PowerShell ExecutionPolicy
- sandbox helper
- shell quoting
- path syntax
- unavailable shell shim

first retry using the project's primary Git Bash environment.

Do not modify application code as a workaround for environment/tooling failures.