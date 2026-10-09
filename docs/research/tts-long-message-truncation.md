# Long TTS messages

## Question
Why does Companion stop reading long messages around 200 characters, and how can full reading preserve the existing queue and skip behavior?

## Current state
Chat messages pass through `buildSpeechParts`, speech normalization, `BoundedTtsQueue`, and `useTwitchChatSession`. Silero receives one request and returns a completed WAV; system speech is the fallback.

## Findings
- Confirmed in source: `maxLength` defaulted to 180, and `buildSpeechParts` sliced the raw message to 179 characters plus an ellipsis before normalization and synthesis. An author prefix can make the spoken text roughly 200 characters.
- The settings UI previously offered only 80, 180, and 300 characters. Saved settings retain the old default unless migrated.
- The Silero IPC timeout is 20 seconds for synthesis, not playback. A timeout rejects synthesis and invokes the system fallback; it does not stop an already playing WAV.
- Playback advances the message queue on audio completion/error or explicit cancellation. Neither the frontend playback path nor the sidecar source contains a 200-character playback cutoff.
- Actual long-message synthesis with the packaged Windows runtime and listening on Windows were not measured in this session. A separate engine limit is not established by this investigation.

## Options
- Raise the default limit: moves the truncation point but still drops text.
- Offer full reading and migrate the old default: removes the confirmed cause without changing queue or playback architecture.
- Split engine requests: useful if an engine limit is demonstrated, but unnecessary for the confirmed preprocessing truncation.

## Recommendation
Use `maxLength: 0` for full reading by default. Migrate saved 180 values to zero; the stored value cannot distinguish the old default from a deliberate 180 choice. Remove the 180 option so it cannot be selected and then unexpectedly migrated on restart. Keep explicit 80 and 300 limits. Keep normalization, one queue entry per message, FIFO selection, existing stale/overflow eviction, fallback, and cancellation unchanged.

## Follow-up
Implemented with regression coverage for complete long text reaching Silero, completion before advancing, skip, migration, and the settings control. If real Windows playback still truncates with full reading selected, inspect the generated WAV and model output before adding sentence splitting.

## Sources
Repository source: `apps/companion/src/chat/chat-model.ts`, `apps/companion/src/chat/useTwitchChatSession.ts`, `apps/companion/src/components/settings/ChatTtsSettings.tsx`, `apps/companion/src-tauri/src/silero.rs`, `scripts/silero_sidecar.py`. No external sources used.
