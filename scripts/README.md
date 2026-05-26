# scripts/

Plain-Node CommonJS scripts that drive the dev Electron over Chrome
DevTools Protocol (CDP) for live testing. They live outside the TS
build and run as `node scripts/<name>.js` after starting the dev
Electron with `ENABLE_CDP=1 npm run dev`.

## Why CDP attach instead of screenshots

The earlier screenshot-driven approach (open the app, screenshot, OCR
the UI, take an action, screenshot again) was slow and brittle. Once
the dev Electron is started with the `ENABLE_CDP=1` opt-in (which
appends `--remote-debugging-port=9222` to the renderer), Playwright
can attach over CDP and drive the UI with DOM-aware selectors —
clicks, fills, eval, `waitForFunction` — orders of magnitude faster
than pixel work.

## Prerequisites

```bash
ENABLE_CDP=1 npm run dev
```

Then in a separate terminal:

```bash
node scripts/<name>.js
```

The shared `scripts/e2e-attach.js` helper handles the CDP handshake;
each repro/probe script imports it.

## What's in here

| Script | What it reproduces / probes |
|---|---|
| `e2e-attach.js` | CDP attach helper used by every other script. |
| `repro-session-cont-error.js` | The "Session continuation requires API key authentication" error — exercises the API_SERVER_KEY desktop/gateway divergence. Setup notes in the file header. |
| `repro-edit-model-emptykey.js` | "Arc Codex" user's Edit Model dialog showing an empty API key field after reopen. |
| `repro-session-proliferation.js` | Marat's session-proliferation symptom (new gateway session per chat). |
| `repro-gateway-restart-midchat.js` | Gateway restart mid-stream, what the user sees in chat. |
| `repro-gateway-restart-v2.js` | Variant of the above with a different timing window. |
| `repro-long-conversation.js` | Long-conversation truncation / context-window behavior. |
| `probe-chat-state.js` | Inspect the renderer's chat state without driving anything. |
| `probe-models-list.js` | Inspect the Models tab's model entries. |
| `probe-selectors.js` | Dump candidate DOM selectors for a given pattern — useful when writing a new repro. |

Each script logs its own `[VERDICT]` line at the end so a CI / batch
runner can grep for pass/fail without parsing the rest of the output.

## When to write a new one

Anytime you're about to "let me check this with a screenshot" — write
a 30-line script instead. The cost of writing one is small, the
benefit is permanent (deterministic, reviewable, runnable on a fresh
machine without you).
