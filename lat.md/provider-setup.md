# Provider setup

The first-run screen where the user picks an AI provider and enters credentials before the app is usable. Rendered by [[src/renderer/src/screens/Setup/Setup.tsx]], it writes the chosen provider/base-URL via `setModelConfig` and any key via `setEnv`.

The provider list is data-driven from `PROVIDERS.setup` in [[src/renderer/src/constants.ts]]. Each entry carries an `envKey`, `configProvider`, `baseUrl`, and `needsKey`; selecting a card drives which form fields show (API key, or the Local server/base-URL flow).

## Setup profile credentials

Setup saves credentials and model configuration to the profile returned by the successful install check, keeping named profiles isolated from the default workspace.

The local first-run gate is profile-aware: `checkInstall` decides whether setup is needed for the active profile, so [[src/renderer/src/App.tsx#App]] passes that profile into [[src/renderer/src/screens/Setup/Setup.tsx#Setup]]. Setup writes `.env` and `config.yaml` to the same profile. A generation guard ensures that only the latest completed install check may select the setup profile.

## Top grid mirrors the agent's native providers

The top provider grid shows only providers the upstream agent supports natively; generic OpenAI-compatible endpoints live in the Local presets instead.

The source of truth is `CANONICAL_PROVIDERS` in the bundled agent (`hermes-agent/hermes_cli/models.py`) — the registry of providers with first-class auth/base-URL handling (nous, openrouter, anthropic, openai-codex, openai-api, gemini, xai, xiaomi, ollama-cloud, deepseek, …). A card belongs in the top grid only if it maps to a canonical slug. `aimlapi` was removed from the grid because it has no canonical entry; it remains reachable as a **Local → Remote OpenAI-Compatible APIs** preset.

## OpenAI-compatible endpoints route through Local

Endpoints the agent does not natively support (Groq, DeepSeek, Together, Fireworks, Cerebras, AtlasCloud, Mistral, AIML, …) are offered as `LOCAL_PRESETS` chips under the `local` card, not as top-level cards.

Selecting a preset sets the base URL; the API-key env var is resolved by `resolveCustomEnvKey` — first an exact `LOCAL_PRESETS.envKey` match, then [[src/shared/url-key-map.ts]] by host. So a compatible provider configures correctly without a dedicated card (e.g. `api.aimlapi.com` → `AIMLAPI_API_KEY`).

## Providers tab routes OpenAI-compatible ids through `custom`

The Providers tab ([[src/renderer/src/screens/Providers/Providers.tsx]]) picks the model provider, but the agent only resolves native providers — selecting an unsupported id otherwise makes the gateway raise `Unknown provider`.

The screen is organized as three tabs: Providers, Models, and Auxiliary Tasks. Providers owns the active provider/model credentials, while Models and Auxiliary Tasks embed [[src/renderer/src/screens/Models/Models.tsx]] so the saved model library and per-task model overrides live beside the provider configuration instead of as a separate sidebar destination.

The picker is a flex-wrap **chip grid** (driven by `PROVIDER_CARDS` in [[src/renderer/src/constants.ts]]) rather than a dropdown: every native provider is a chip, and a terminal `local` ("Local / Others") chip reveals the `LOCAL_PRESETS` rows (local servers + remote OpenAI-compatible endpoints). `selectProvider` is the shared click handler for the provider chips and the preset chips.

Once a provider is configured the grid collapses to a read-only summary (logo + provider label + model/base-URL); a **Change** button in the section header (`editingProvider` state) re-opens the full chip grid and the editable model/base-URL fields. An unconfigured (`auto`) selection always shows the grid.

For compatible/custom endpoints, an inline **API Key** field appears under Base URL, stored under the host-derived env var (`resolveCompatEnvKey`: preset `envKey` else `expectedEnvKeyForUrl`, e.g. AtlasCloud → `ATLASCLOUD_API_KEY`). It shares the `env` state with the lower LLM-provider key cards, so either entry point stays in sync.

Ids the agent can't resolve by id are listed in `OPENAI_COMPATIBLE_BASE_URLS` ([[src/renderer/src/constants.ts]]) — openai, perplexity, and every `LOCAL_PRESETS` chip (local servers + remote endpoints like groq, deepseek, atlascloud, mistral, …). This map MUST contain every preset id, or selecting that chip mis-routes; a test in `tests/constants.test.ts` enforces it. Selecting one autofills its base URL and shows the base-URL field; on save it is persisted as `provider: custom` + `base_url`, which the gateway accepts and uses to host-derive the API key (`runtime_provider._host_derived_api_key`, e.g. `api.groq.com` → `GROQ_API_KEY`). `displayProviderFromConfig` reverse-maps a stored `custom` + known base URL back to the brand id so the dropdown re-selects it on load. Native providers (the gateway hardcodes their base URL) clear the field instead.

## Switching providers rewrites the transport (`api_mode`)

Activating a model must rewrite or clear `model.api_mode`, or a stale protocol from the previous model routes the new endpoint over the wrong transport — dropping connections when switching OpenAI- and Anthropic-compatible custom endpoints.

The gateway's runtime-provider resolver honors a persisted `model.api_mode` (`anthropic_messages` vs `chat_completions`, …) for `custom`/compatible providers, and only auto-detects from the base URL (`/anthropic` suffix, `api.openai.com`, …) when the key is absent. So a leftover `anthropic_messages` would keep an OpenAI-compatible endpoint pointed at `/v1/messages` (404 / lost connection).

[[src/main/config.ts#setModelConfig]] takes an optional `apiMode` argument, handled exactly like `context_length`: a non-empty string sets `model.api_mode`, `null`/empty removes it (so auto-detection resumes), `undefined` leaves it untouched. The `set-model-config` IPC handler ([[src/main/ipc/register.ts]]) resolves it from the activated model's `apiMode` library field ([[src/main/models.ts#SavedModel]]) — `null` when the entry has none — alongside the `contextLength` mirror, on both the pure-local and remote-fallback local writes. Custom-provider library entries carry `apiMode` because `loadCustomProviders` reads `api_mode` from each `custom_providers:` block.

The library lookup runs through [[src/main/ipc/register.ts#resolveLibraryModelEntry]], which disambiguates by base URL when several entries share the same provider+model — e.g. two `custom` endpoints exposing the same model id over different transports. A bare provider+model match would return the first entry and persist its `api_mode` for the other endpoint, routing it over the wrong protocol; matching the base URL too keeps each endpoint's transport correct. Single-entry activations are unaffected.

## Provider icons

Each card's logo is resolved by [[src/renderer/src/components/common/BrandLogo.tsx]] from the provider id, falling back to a generic robot for unknown ids.

`detectBrand` matches the provider/model string to a `BrandKey`, and `matchTheme` flattens every logo to a single white/black tint so colored and `currentColor` SVGs render uniformly in the grid's logo tiles.

The Local/Remote preset chips are also branded: each renders the same `BrandLogo` (by preset id) to the left of its name in a row. `llama.cpp` is mapped off the Meta logo to the generic API mark (the `/llama/` substring would otherwise tag it, and Ollama, as Meta); any preset without a bundled logo falls back to the generic mark.

## MiniMax OAuth discovery fallback

When live OAuth discovery is unavailable, MiniMax keeps a usable model list aligned with Hermes Agent's curated OAuth choices.

[[src/main/model-discovery.ts#discoverProviderModels]] falls back to `MiniMax-M3`, `MiniMax-M2.7`, and `MiniMax-M2.7-highspeed` if the Python query fails. Regression coverage preserves all three entries; successful live discovery still takes precedence.

## Novita provider preset

Novita is available as a remote OpenAI-compatible preset, with a dedicated API-key field and the same endpoint used by Hermes Agent.

The desktop stores the model as `custom` at `https://api.novita.ai/openai/v1`. Setup, the configured-provider picker, installer readiness, and runtime key lookup use `NOVITA_API_KEY`; provider branding identifies the endpoint as NovitaAI. The shared URL mapping is covered alongside the other supported commercial endpoints.

## Auxiliary credential ownership

Auxiliary credentials belong to the selected provider and endpoint. Switching either clears stale task-level secrets and pointers; model-only changes preserve them.

[[src/main/auxiliary-config.ts#setAuxiliaryTask]] clears `api_key`, `key_env`, `api_key_env`, legacy `api`, and `api_mode` when the provider or normalized endpoint changes, or routing returns to `auto`. RAZUM keeps this logic independent of upstream's Hermes One named-provider registry.

[[src/main/auxiliary-config.ts#resetAuxiliaryToAuto]] clears the same overrides for every task. The text editor changes only direct task fields, preserving nested `extra_body`, other tasks, comments, and line endings; unsupported flow mappings fail before writing.

### Provider and endpoint changes

Switching providers or changing an endpoint removes prior credential aliases and transport overrides so they cannot leak into the next route.

### Model-only changes

Changing the model under the same effective provider and endpoint preserves task-specific credentials and transport settings. Omitted versus explicit native default URLs resolve to the same route.

### Reset persistence

Resetting to the main model persists `auto` routing without stale task-level credentials, while leaving unrelated settings intact after reload.

### YAML field boundaries

Routing updates and credential removal address direct task children only, preserving nested options, comments, empty task maps, multiline values, and CRLF line endings.

## Custom provider credential readiness

Saved RAZUM custom providers use their model-library name and normalized base URL as the credential identity, without requiring the upstream Hermes One provider registry.

The shared [[src/shared/url-key-map.ts#customProviderEnvKey]] transform maps the saved name to `CUSTOM_PROVIDER_<NAME>_KEY`. Endpoint comparison normalizes scheme and host case, default ports, and trailing slashes while preserving path and query case.

### Readiness and profile isolation

Readiness checks accept a per-name key only when a saved `custom` model matches the active endpoint and the selected profile owns the credential.

The credential may come from the profile environment or its resolved secret provider. A named profile never borrows the default profile's key.

[[src/main/models.ts#readModelsRaw]] resolves the model-store path at call time so the config-to-models import cycle cannot access `HERMES_HOME` before installer initialization finishes.

### Runtime parity

CLI launch applies the same endpoint match, skips matching saved rows whose per-name key is empty, and continues until it finds a usable key in the selected profile environment or enumerated secret provider.
