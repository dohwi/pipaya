This page covers model connections and **model routing** (which model to use in which situation). All settings are stored on the server and shared by every device that connects.

> [!NOTE]
> A new server has no models connected. While the model list is empty you cannot chat, and a **Connect a model** button appears on screen.

## How to connect

**Settings → Model connections → Add connection**

### Built-in providers

These are the providers built into the server (OpenAI, Anthropic, Google, OpenRouter, GitHub Copilot and others). The authentication method differs per provider; see `loginMethods` in `GET /providers`.

| Method | Description |
|---|---|
| API key | Enter a key and it is stored on the server |
| Sign in (OAuth) | The server runs the sign-in procedure and the app guides you through opening the link and entering the code. You can also finish by pasting the redirect URL |

Some providers that need a key have an interactive setup under `Set API key` with follow-up questions. Start a sign-in with `POST /providers/:id/login`, check progress (link to open, device code, pending question) with `GET /logins/:id`, answer a question with `POST /logins/:id/answer` and cancel with `POST /logins/:id/cancel`. A sign-in expires after **10 minutes**, and starting a new one for the same provider cancels the earlier one.

### Local model presets

OpenAI-compatible servers that need no key.

| Name | Default address |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

> [!WARNING]
> The **server** connects to these addresses. `localhost` is the server machine, not the device where you opened the app. If you run the server in Docker, point to a model on the host with `host.docker.internal` → [[installation]].

### Manual entry (custom endpoint)

| Field | Rule |
|---|---|
| Name | For display |
| ID | Starts with a lowercase letter; lowercase letters, digits, `_` and `-`; up to 64 characters |
| Base URL | `http(s)://`. No credentials, query or fragment |
| API format | `openai-completions`, `openai-responses`, `anthropic-messages` |
| Key required | `authRequired` — turn off for local servers |
| Model ID | Entered by hand. Up to 100 per connection |
| Context window | 128 to 10,000,000 |
| Max output | 1 up to the context window |
| Reasoning / vision | Check if the model supports them (`reasoning`, `vision`) |

The body when registering through the API:

```json
{
  "name": "Local Ollama",
  "baseUrl": "http://model-host:11434/v1",
  "api": "openai-completions",
  "authRequired": false,
  "models": [
    { "id": "qwen3:8b", "name": "Qwen 3 8B", "contextWindow": 32768, "maxTokens": 4096, "reasoning": false, "vision": false }
  ]
}
```

There is a bundled OpenRouter catalog for model ID autocomplete (`GET /configuration/catalog`), and if an endpoint provides a model list you can load it with `POST /configuration/discover`. A connection's model list is synchronized with the upstream in the background at startup (refresh manually with `POST /configuration/providers/:id/refresh`), and models that disappeared upstream are marked `available: false`.

### Connection test

`POST /configuration/test` sends **one real model request** (up to 32 output tokens, 30-second limit). The response is `{ok, durationMs, text?, error?}` and **it may incur charges.**

### Good to know

- Editing an endpoint takes effect **from the next request**.
- Deleting a provider or model that the default or a session uses is rejected with `409`.
- Custom connections have no price, so the recorded cost is 0. That does not mean it is free.
- Connection addresses intentionally allow LAN and Tailscale targets. Register only addresses you trust.
- Keys are stored in the server's SQLite **without encryption** → [[security]].

## Model routing

You can set models separately by purpose. You can use an expensive model for the main chat and cheaper ones for summaries, research and title generation.

| Purpose | Where to set | Notes |
|---|---|---|
| Default model | Settings → Model connections → Default | Applies to **new sessions only** |
| Session model | The chat's model picker ({{Alt+M}}) | Differs per session |
| Favorites cycle | {{Alt+Shift+M}} | Only starred models, in order |
| Context compaction | Settings → Model connections → Compaction (`/compaction`) | Summary model. If empty, the session model |
| Sub-agents | Settings → Agents | A model per helper. If empty, the calling chat's model |
| System model | `/system-model` | A light model that writes the session **title and purpose**. Off if empty |
| Role | `/model-roles` | Named model slots used by the server and extensions |

```text
Session model  ─ the chat itself runs on this model
   │
   ├─ when compacting          → compaction model (session model if none)
   ├─ delegate call            → the helper's model (the calling chat's model if none)
   ├─ session title / purpose  → system model (off if none: the title is the first 60 characters of the first message)
   └─ one-off server/extension calls → role mapping (default model if none)
```

A startup default can be given with the environment variables `PIPAYA_PROVIDER` / `PIPAYA_MODEL`. A stored default takes priority. Clearing the default by setting it to `null` returns to the startup default or the first configured model.

### System model

A **light model** the server uses separately from the chat. Right now it is used to write a session's title and purpose (what the session is responsible for). The purpose lets other sessions know "what this session does" before calling it with `@` → [[orchestration]].

- `PUT /system-model` `{"model": {"provider", "model", "thinkingLevel"?} or null}`
- `null` turns it off. If the chosen model is later deleted, it quietly turns off.
- The title is at most 60 characters (the model is asked for within 40), the purpose at most 120 (the model is asked for within 80), and the output at most 400 tokens.

### Roles

Named **model slots** such as `light`, `summary` and `explore`. The server and extensions refer only to role names, not specific models, so when you later swap in a cheaper model you only edit one line of the mapping.

- Name: starts with a lowercase letter; lowercase letters, digits and `-`; up to 40 characters
- Up to 20. `PUT /model-roles` **replaces the whole table**, so `GET` it first and edit.
- The mapped model must really exist to be saved (a typo is rejected at save time).
- If there is no mapping or the model is gone, the default model is used.

`POST /llm/complete` is a **one-off text completion** with no session, no tools and no history. It is the basic building block the server and extensions use for summarizing, classifying and translating, and you choose the target with either `role` or `provider`+`model` (giving both returns `400`).

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"roles":{"light":{"provider":"openai","model":"gpt-5-mini"}}}' \
  http://<server address>:8787/model-roles
```

> [!NOTE]
> `openai` and `gpt-5-mini` in the example are placeholders. Replace them with a real provider and model ID checked with `GET /models`.

## Reasoning strength

| Level | Description |
|---|---|
| `minimal` | Minimal. The default for sub-agents |
| `low` | Low |
| `medium` | **Default** |
| `high` | High |
| `xhigh` | Very high |
| `max` | Maximum |

- `off` (turning reasoning off) is not supported. Existing `off` sessions are moved to `medium`.
- A model that does not support reasoning ignores the chosen strength.
- The levels a model accepts differ, so see the per-model list in `thinkingLevels` of `GET /models`.
- Cycle with {{Alt+T}} (`minimal → … → max`, wrapping from the end to the start).

## Model catalog lookup

The entries returned by `GET /models?provider=&configured=true`.

| Field | Description |
|---|---|
| `provider`, `id`, `name` | Identification |
| `api` | API format |
| `reasoning`, `thinkingLevels` | Whether reasoning is supported and which levels it accepts |
| `contextWindow`, `maxTokens` | Context window, max output |
| `vision` | Image input support → decides whether attached images are sent as images ([[composer]]) |
| `configured` | Whether authentication is ready |
| `available` | Whether it is still in the connection's model list |

## Managing API keys

| Action | API |
|---|---|
| Save a key | `PUT /providers/:id/credential` `{key}` |
| Delete a key | `DELETE /providers/:id/credential` |
| Provider status | `GET /providers` (key values are not returned) |
| Start sign-in | `POST /providers/:id/login` |
