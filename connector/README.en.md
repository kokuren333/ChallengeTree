# Challenge Tree portable local connector

[日本語のガイド](README.md)

This is a dependency-free HTTP/SSE connector between the static Challenge Tree site and the user's local Codex App Server. It uses only Node.js built-ins.

## Scope

`server.js` and `codex-app-server-client.js` provide:

- HTTP on localhost only
- Exact browser-origin allowlist validation
- An ephemeral session token rotated on every start
- Job queueing, cancellation, and SSE event delivery
- Five high-level Challenge Tree AI operations
- Codex CLI detection, App Server startup, reconnect, and shutdown
- JSONL request/response correlation for the generated App Server protocol
- Authentication, model catalog, and reasoning-effort availability checks
- Strict structured output with one repair turn
- Native Codex Web Search event verification and research evidence in the result envelope

Allowed operations:

```text
TREE_PROPOSE
NODE_EXPAND
NODE_CREATE
CHALLENGE_CREATE
ANSWER_GRADE
```

The connector does not expose arbitrary shell execution, file writing, or arbitrary Codex command forwarding. The App Server is started without a shell, threads use read-only sandboxing, and approval or interactive server requests are not automatically granted.

## Start

Node.js 18 or newer is recommended. No connector dependencies are required.

```powershell
node connector/server.js
```

The `/v1/status` endpoint reports whether Codex was found, whether the App Server is running, authentication state, model availability, CLI/App Server versions, and recent errors. The web UI uses the same status.

The connector searches for Codex in this order:

1. `CHALLENGE_TREE_CODEX_PATH`, when explicitly set
2. The current PATH
3. Conventional OS locations such as `~/.local/bin`, `~/bin`, macOS Homebrew paths, Linux system bin paths, and the npm global bin directory

Defaults:

```text
host: 127.0.0.1
port: 43110
allowed origins: GitHub Pages + localhost:5173/4173
```

GitHub Pages and the usual Vite development origins are allowed by default. Other origins must be explicitly added; `*` is rejected.

```powershell
$env:CHALLENGE_TREE_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
$env:CHALLENGE_TREE_PORT = "43110"
node connector/server.js
```

`CHALLENGE_TREE_HOST` accepts only `127.0.0.1` or `::1`. LAN and `0.0.0.0` binding are not allowed. The startup token is printed to stderr, kept in memory by the web UI, and rotated on restart.

## HTTP API

All endpoints except `/v1/status` require the ephemeral token in either form:

```http
Authorization: Bearer <ephemeral-token>
```

or:

```http
X-Challenge-Tree-Token: <ephemeral-token>
```

### `GET /v1/models`

Returns the Codex App Server model catalog, each model's supported reasoning efforts, and the selected model. The web settings screen uses this endpoint.

### `POST /v1/settings/model`

Applies a model and optional reasoning effort to the running connector process. The web UI persists the selection and reapplies it after reconnecting.

```json
{
  "model": "gpt-5.5",
  "reasoningEffort": "medium"
}
```

### `GET /v1/status`

Reports connector and Codex status. The response includes the current in-memory token while the connector is running.

### `POST /v1/jobs`

Creates an asynchronous job. The body contains one operation envelope:

```json
{
  "operation": "TREE_PROPOSE",
  "protocolVersion": 1,
  "requestId": "optional-client-id",
  "payload": {
    "topic": "Transformer",
    "goal": "Understand technical papers",
    "researchMode": "global",
    "challengeMode": "explain"
  }
}
```

The response is `202 Accepted` with a `jobId` and `eventsUrl`. Lowercase operation names such as `tree_propose` are also accepted.

### `GET /v1/jobs/:id/events`

Streams job events over SSE. The browser UI uses a `fetch` streaming response because the standard `EventSource` API cannot send custom authorization headers.

Client-facing event names are:

```text
status
progress
result
error
done
```

### `POST /v1/jobs/:id/cancel`

Cancels a running job. Completed or already-cancelled jobs are unchanged.

## Native Web Search requirement

Every AI operation instructs Codex to use native Web Search. The connector collects raw `webSearch`, `web_search`, or `web_search_call` completion events and attaches them to the completed turn before validating the result. The successful result is returned as:

```text
{ data, research }
```

`research` contains only Codex-returned search terms, source URLs, and progress logs. If no completed native search event is found, the result is rejected with `native_research_required`; no AI result or research record is saved. There is no connector-side DuckDuckGo fallback.

## Security assumptions

- The connector listens on loopback only
- Browser origins are checked by exact allowlist matching
- Job creation, event subscription, and cancellation require the ephemeral token
- Tokens, answer text, and Codex credentials are not written to disk
- Request bodies and SSE events have size limits
- Jobs are held in memory and expire after completion
- Imported saves and AI input are never treated as executable content

## Protocol

`protocol/generated/` and `protocol/schema/` are generated from the installed Codex CLI:

```powershell
codex app-server generate-ts --experimental --out protocol/generated
codex app-server generate-json-schema --experimental --out protocol/schema
```

The bridge uses `initialize`, `getAuthStatus`, `model/list`, `thread/start`, `turn/start`, raw item events, and `turn/completed`. Challenge Tree's XP, unlock, and persistence logic remains in the web app, not in the connector.
