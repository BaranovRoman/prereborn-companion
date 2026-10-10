# Companion Plugin Manager — iteration 3

## Question
How to install and manage official plugins inside Companion while keeping the built-in Dota
runtime, existing stream services, paths and application updater untouched?

## Current state
Feature branch `codex/plugin-runtime-prototype` already has split CoreState/DotaState,
IPC v1 Rust PluginHost and a separate Hello process/UI. Plugin Lab's sandboxed iframe was
verified on WKWebView in iteration 2, not this new manager iteration. No plugin publication
infrastructure or release signing key previously existed.

## Findings
- The existing runtime can be reused per plugin. Only the expected handshake identity/version
  needed parameterization; no second process framework was introduced.
- ZIP, SHA-256 and Minisign verification dependencies already exist in the host dependency
  tree. A small standalone package crate allows installer security tests without Tauri bundles.
- Signed archive + signed manifest inventory allow verification before extraction and again
  before launch. Installed extra files must also be rejected to avoid executable side-loading.
- Staging rename plus recoverable registry replacement separates a downloaded update from the
  running version. Invalid pending updates retain the old version and a persistent error.
- Local Tauri 2.11.5/Wry source confirms WebView2 injects initialization scripts into subframes.
  Merely sandboxing the iframe cannot justify giving it the invoke key. An upstream-equivalent
  IPC bootstrap with an early subframe guard is used; JS tests validate main-frame transport
  and subframe exclusion. Real Windows behavior has **not** been measured.
- Existing app updater uses the application's GitHub `releases/latest/download/latest.json`.
  Plugin endpoints instead target a separate planned `prereborn-companion-plugins` repository,
  not yet created or published. An embedded signed Hello catalog enables local development.

## Options
1. Put store/lifecycle in React: easier initial UI, but signing/files/process ownership and
   recovery would be spread across layers. Rejected.
2. Add a second process manager or move Dota now: unnecessary migration risk. Rejected.
3. Rust registry/installer, existing PluginHost, small React view: chosen; crypto/archive
   checks stay testable independently and stream services do not share manager locks.

## Recommendation
Use the implemented schema-1 signed packages, official embedded trust anchor and separate
GitHub catalog, with deferred update activation and explicit verified rollback. Keep Dota
reserved/built in, and use the Hello package for this migration gate.

Private official key is local/ignored, separate from test and application updater keys.
Arrange secure backup/production key custody before publication. Native processes retain
user OS privileges; manifest permissions and IPC isolation are not an OS sandbox. Catalog
signatures establish authenticity, not expiry/revocation; a future production trust policy
must address key rotation and compromised/withdrawn official versions.

## Follow-up
See `plugins/README.md` for format, packaging, local store test, publishing preparation and
checks. This iteration does not publish, merge main, build app bundles, rebuild overlay or
Silero. Actual new WKWebView store UI, HTTPS delivery from published releases and Windows
smoke remain unverified, along with live stream/Dota/OBS regressions and forced power-loss.

Next safe step: complete manager UAT on macOS and Windows (including blocked iframe native IPC
and real Twitch/TTS while installing/crashing Hello), then define Dota's external adapter
contracts behind the already existing boundary. Keep exactly one built-in Dota runtime until
its migration equivalence/rollback gates pass; do not extract GSI/OBS/SQLite/overlay yet.

## Sources
Read actual local source and existing contract tests. Primary implementation references:
- Tauri 2.11.5 `manager/webview.rs`, `scripts/ipc-protocol.js`,
  `scripts/process-ipc-message-fn.js` (vendored copies retain upstream license):
  https://github.com/tauri-apps/tauri/tree/tauri-v2.11.5/crates/tauri
- Wry 0.55.1 `with_initialization_script_for_main_frame` platform caveat:
  https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/lib.rs
- Local `minisign-verify 0.2.5` PublicKey/Signature/verify source and `zip 2.4.2` entry metadata.
