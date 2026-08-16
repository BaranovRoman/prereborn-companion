# Graphify setup

Graphify (`graphify-mcp`) is a code knowledge graph exposed to AI agents over MCP. It is a
navigation aid for AI agents working in this repo — not a runtime dependency of the
product, and not installed as part of `pnpm install`.

Upstream project: https://github.com/yasinyaman/graphify-mcp

## Prerequisites

- Python 3.10+ (not installed by default on this project's Windows dev machines — install
  it once per machine, e.g. `winget install Python.Python.3.12`).
- Not published on PyPI as of this writing (2026-08) — install from source.

## Install (once per machine)

```bash
python -m pip install --user "graphify-mcp[graphify,treesitter]@git+https://github.com/yasinyaman/graphify-mcp.git"
```

- `graphify` extra pulls in the `graphifyy` CLI, which builds the graph.
- `treesitter` extra is required for non-Python languages (this repo is TypeScript/React +
  Rust/Tauri, so this extra is necessary here).

This installs two console scripts: `graphify` (CLI) and `graphify-mcp-server` (MCP server).
On Windows with a user install, they land in
`%AppData%\Python\Python3XX\Scripts\` — add that directory to `PATH`, or reference the
scripts by full path in your local MCP config.

## Build the graph

Run once, and again after structural changes (new files, moved code):

```bash
graphify update . --no-cluster
```

`--no-cluster` skips LLM-based community labeling, which needs an API key
(`GEMINI_API_KEY`/`GOOGLE_API_KEY` or similar). Structural extraction (`graphify update`)
needs no API key and no key is configured for this project — community labels are not
part of this setup. This is not a limitation for navigation use: `graphify_locate`,
`graphify_path`, `graphify_impact`, `graphify_neighbors`, `graphify_search`, etc. all work
against the structural graph.

Output goes to `graphify-out/` at the repo root (gitignored — do not commit it; it's a
local, disposable cache, same category as `node_modules/` or `dist/`).

## MCP configuration

`.mcp.json` (gitignored, machine-local) is the project's existing convention for MCP
server configs with local paths — see `.mcp.json.example` for the pattern already used for
the `weeek` server. A `graphify` entry has been added to both files. Copy
`.mcp.json.example` to `.mcp.json` and adjust the `command` path if the Scripts directory
isn't on your `PATH`.

Do not commit machine-specific absolute paths or secrets. `graphify-mcp-server` itself
needs no API key for the structural toolset used here.

## Verification performed (2026-08-17)

Installed and indexed this repo (1917 nodes, 4304 edges from 285 source files) and ran
read-only navigation queries via the CLI (`graphify query`, `graphify god-nodes`) as a
stand-in for the MCP tools, which use the same underlying graph:

- **Stream authentication path** (`graphify query "stream authentication route middleware
  controller storage"`) — correctly surfaced `apps/api/src/routes/stream/*`,
  `apps/api/src/controllers/stream/overlay.ts`, and the relevant `*-service.ts` files
  without reading them first.
- **OBS scene mapping** (`graphify query "OBS scene mapping override"`) — correctly
  surfaced `apps/companion/src/components/obsSceneMapping.ts`,
  `apps/api/src/services/obs-scene-command-service.ts`, and the Rust side
  (`apps/companion/src-tauri/src/obs.rs`).
- **Recent Games data flow** (`graphify query "recent games matches data flow"`) —
  correctly surfaced `apps/web/src/components/pages/overlay/widgets/recent-matches.tsx`,
  `apps/api/src/controllers/stream/matches.ts`, and
  `apps/api/src/services/stream-match-service.ts`.

All three returned genuinely relevant entry points across the monorepo (Node/Express API,
Next.js web app, Rust/Tauri companion) in one call each, instead of a manual multi-file
grep/read sequence. No subsystem was modified as part of this verification.

## Known limitations

- Community labeling (`graphify_communities` / human-readable cluster names) requires an
  LLM API key that isn't configured for this project. Structural navigation tools don't
  need it and were the ones verified above.
- The graph is a point-in-time snapshot; it can drift from the working tree after edits.
  Re-run `graphify update . --no-cluster` after structural changes, and always treat actual
  source as the source of truth over graph output (see AGENTS.MD).
- No monorepo-specific issues were found — both the TypeScript/React side and the Rust/Tauri
  side were indexed and queryable in the same graph.
