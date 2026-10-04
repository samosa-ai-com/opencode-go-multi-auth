# OpenCode Go Multi-Account Router

> **⚠️ Educational Purpose Only** — This project is provided for learning and educational purposes. It demonstrates how to build a multi-account proxy router for OpenCode Go and Zen API subscriptions. Users are responsible for complying with OpenCode's terms of service.

A native TypeScript OpenCode plugin and proxy router that pools multiple OpenCode Go + Zen API subscriptions into a single endpoint. Instead of manually swapping API keys between accounts when one runs out of quota, this router handles it automatically. It routes requests across accounts using cache-aware or load-spreading strategies, auto-starts with OpenCode in plugin mode, and includes a persistent control-room dashboard for key management, usage analytics, and live observability.

> **Note for end users:** If you just want to use the router (not develop it), follow the [Installation](#installation) guide and ignore files like `restart-router.sh`, `AGENTS.md`, and `Developers Log/` — those are for project maintainers.

> **💰 Support the project:** Use this referral link to [sign up for OpenCode Go](https://opencode.ai/go?ref=HF6N2D2RCR) and get **$5 free credit** to start. Every referral helps keep this project maintained.

## Preview

Click any screenshot to view full resolution.

<table>
  <tr>
    <td align="center">
      <a href="resources/overview.png">
        <img src="resources/overview.png" width="400" alt="Overview">
      </a>
      <br>
      <strong>Overview</strong> — KPI strip, quota-error panel, token throughput chart
    </td>
    <td align="center">
      <a href="resources/accounts.png">
        <img src="resources/accounts.png" width="400" alt="Accounts">
      </a>
      <br>
      <strong>Accounts</strong> — Key management, priority, masking, live stats
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="resources/routing.png">
        <img src="resources/routing.png" width="400" alt="Routing">
      </a>
      <br>
      <strong>Routing</strong> — Strategy selection and descriptions
    </td>
    <td align="center">
      <a href="resources/tokens.png">
        <img src="resources/tokens.png" width="400" alt="Tokens">
      </a>
      <br>
      <strong>Tokens</strong> — Per-model usage, cost, and time series
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="resources/logs.png">
        <img src="resources/logs.png" width="400" alt="Logs">
      </a>
      <br>
      <strong>Logs</strong> — Routing tape with search, filters, and cost
    </td>
    <td></td>
  </tr>
</table>

## Features

- **Three Routing Strategies** — Priority Failover (cache-first default), Round Robin, Weighted Cycle. Each explained in the dashboard UI.
- **Dual upstream** — Same proxy serves OpenCode Go (paid) and OpenCode Zen (free tier). Requests with a `/zen/` path prefix are forwarded to `https://opencode.ai/zen/v1`; everything else goes to `https://opencode.ai/zen/go/v1`. Both upstreams share keys, priority, weight, cooldown, and circuit breaker.
- **React, don't predict** — The router does **not** estimate quota. It only marks a key as exhausted when the upstream itself returns 402/429 with a quota body, and uses the upstream-supplied cooldown. Cost is recorded for display only.
- **Cost estimation** — The OpenCode Go upstream does not return a `cost` field, so the proxy falls back to a per-model rate card sourced from the OpenCode Go docs. Estimated costs render in yellow italic with a `~` prefix and a tooltip; actual upstream costs render plain. Tiered pricing (Qwen3.6/3.7 Plus, Qwen3.7 Max) applies the higher tier when `cacheRead + input > 256_000` tokens.
- **Zen model drift detection** — The Models page compares the user's `opencode.json` config against the live Zen upstream catalog. A banner lists new free models not yet in the user's config with a "Copy snippet" button so the user can paste them in. Re-checks every 12 hours while the page is open.
- **Persistent Key Settings** — Enable/drain, priority, weight, and alias survive restarts. Keys are stored with stable IDs and encrypted at rest.
- **Per-Key Analytics** — Request count, success/error rate, average latency, token breakdown, last model used, last session ID, observed cost, and quota-error tally.
- **Stream-Aware Usage Tracking** — Parses token usage from both full JSON and SSE streaming completions. Injects `stream_options.include_usage` for OpenAI-compatible streams.
- **Circuit Breaker** — Temporarily removes unhealthy keys after 3 consecutive 5xx errors, auto-recovers after 5 minutes.
- **Cache-Preserving Header Passthrough** — Forwards `X-Session-Id`, `prompt_cache_key` / `prompt-cache-key`, `cache_control` / `cache-control`, plus both bearer and `x-api-key` auth for broader model compatibility.
- **Local Web UI Control Room** — Strategy explainer, key deck with inline editing, live usage ledger, quota-error panel, routing tape with per-request route reasons and session IDs, model catalog with visibility controls, and a drift detection banner.
- **Secure Key Storage** — AES-256-GCM encrypted at rest using PBKDF2-derived key from machine identity.
- **Push Notifications** — Optional ntfy notifications for key exhaustion, all-keys-exhausted, and circuit-breaker trips/recovery. Configurable from the dashboard Settings page with hot-reload.
- **Auto-Starting OpenCode Plugin** — Install as an OpenCode plugin so the proxy and dashboard start with OpenCode automatically.
- **Standalone or Library** — Keep a CLI/server mode for debugging, fallback use, or external automation.

## Prerequisites

- **Node.js** >= 22 (required by transitive dependencies)
- **npm** or **bun** or **pnpm**
- **OpenCode CLI** >= 1.18.29 (for OpenCode V1) or OpenCode V2 (required for dual-entrypoint plugin support), configured with a Go subscription (Zen is optional but recommended)

## Installation

```bash
git clone https://github.com/samosa-ai-com/opencode-go-multi-auth.git
cd opencode-go-multi-auth
npm install
npm run build
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/opencode-go-multi-auth.js <<EOF
export { default, server, pluginModule } from "$(pwd)/dist/opencode-plugin.js"
EOF
```

The cloned repo must stay — the plugin loader points to its `dist/` directory.

## Updating an existing installation

If you installed the router from the default branch, update it from the repository root:

```bash
cd /path/to/opencode-go-multi-auth
git status
git fetch origin
git switch main
git pull --ff-only origin main
npm ci
npm run typecheck
npm run build
```

Review any local changes reported by `git status` before switching branches. Do not discard them with a forced reset.

Restart the router using the mode you use. For plugin mode or a manually started router, run:

```bash
./restart-router.sh
```

For the Linux systemd user service, run:

```bash
systemctl --user restart opencode-go-router.service
```

Use only one restart method. Verify the updated router after restarting:

```bash
curl -fsS http://127.0.0.1:18904/healthz
curl -fsS http://127.0.0.1:18905/v1/models
```

The plugin loader and runtime state can remain in place. Encrypted keys and usage data are stored under `~/.opencode/`, not in the repository.

### OpenCode config

Add providers that route through the proxy in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode-go": {
      "options": {
        "baseURL": "http://localhost:18905"
      },
      "models": {
        "deepseek-v4-flash": {}
      }
    },
    "multi-auth-zen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Zen (multi-auth)",
      "options": {
        "baseURL": "http://localhost:18905/zen"
      },
      "models": {
        "deepseek-v4-flash-free": {},
        "mimo-v2.5-free": {},
        "qwen3.6-plus-free": {},
        "minimax-m3-free": {},
        "nemotron-3-ultra-free": {},
        "north-mini-code-free": {}
      }
    }
  }
}
```

The loader file in `~/.config/opencode/plugins/` is auto-loaded — no `plugin` array needed in the config.

Then close any existing OpenCode sessions and open a fresh one. The plugin will start or reuse one shared local router daemon, which serves:

- **Proxy endpoint** — `http://localhost:18905`
- **Dashboard** — `http://localhost:18904`

### Open the Dashboard

Navigate to **[http://localhost:18904](http://localhost:18904)** in your browser. If the page does not open, first open a fresh OpenCode session so the plugin can start the router daemon.

### Add your Go API keys

1. Click **Add Key**
2. Paste your OpenCode Go API key (found in your OpenCode account settings)
3. Optionally give it an alias, priority, and weight
4. Repeat for each Go account you want to pool

### Standalone mode (fallback)

If you do not want plugin mode, you can still run the router manually:

```bash
npm start
```

Or directly:

```bash
node dist/bin.js
```

In standalone mode you must start the router yourself after reboot. Plugin mode avoids manual startup when opening OpenCode, but it is not an OS boot service.

Whenever you change the source locally, rebuild before restarting:

```bash
npm run build
```

## Compatibility Notes

> **Note:** This project has been tested on Linux. macOS has not been tested yet — if you run into issues, please open a GitHub issue.

- Some OpenCode Go models use `/messages` with Anthropic-style auth. The proxy now forwards both `Authorization: Bearer ...` and `x-api-key` to maximize compatibility.
- If a new model still fails, capture the exact model name and the `/messages` or `/chat/completions` path from the router log.

## Dual upstream: Go and Zen through the same proxy

The proxy serves both **OpenCode Go** (paid subscription) and **OpenCode Zen** (free tier + paid models) from the same `localhost:18905`. Requests whose path starts with `/zen/` are forwarded to `https://opencode.ai/zen/v1`; everything else goes to `https://opencode.ai/zen/go/v1`. The `/zen/` prefix is stripped before forwarding.

Both upstreams support Anthropic-format (`/v1/messages`) and OpenAI-format (`/v1/chat/completions`) requests. The free Zen models use the OpenAI format, so add a **second** custom provider alongside the built-in `opencode-go` you already set up (see the [Installation config](#opencode-config) for the full example):

```json
{
  "provider": {
    "opencode-go": {
      "options": { "baseURL": "http://localhost:18905" },
      "models": { "deepseek-v4-flash": {} }
    },
    "multi-auth-zen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Zen (multi-auth)",
      "options": { "baseURL": "http://localhost:18905/zen" },
      "models": {
        "deepseek-v4-flash-free": {},
        "mimo-v2.5-free": {},
        "qwen3.6-plus-free": {},
        "minimax-m3-free": {},
        "nemotron-3-ultra-free": {},
        "north-mini-code-free": {}
      }
    }
  }
}
```

Then reference the provider from agents as `multi-auth-zen/<model>`, e.g.

```json
{
  "agent": {
    "explore": { "model": "multi-auth-zen/deepseek-v4-flash-free" },
    "general": { "model": "multi-auth-zen/deepseek-v4-flash-free" }
  }
}
```

**Important:** the provider name must be unique. Do **not** use `opencode-zen` or `opencode` — those collide with OpenCode's built-in Zen provider and OpenCode will silently route requests directly to `opencode.ai`, bypassing the proxy entirely. Any other name (e.g. `multi-auth-zen`, `proxy-zen`, `my-zen`) works.

When new free models appear upstream, the dashboard's **Models** page surfaces a drift banner with a **Copy snippet** button so you can paste the missing models into your `models` block. The check runs every 12 hours while the page is open. You can also change the provider name tracked by the dashboard via the text input next to the Save button (default: `multi-auth-zen`).

## Routing Strategies

All strategies are explained in the dashboard UI. Here is a quick reference:

| Strategy | Cache-friendly | Priority-aware | Weight-aware | Best for |
|---|---|---|---|---|
| **Priority Failover** (default) | Yes | Yes | No | Keep one account warm for cache reuse |
| **Round Robin** | No | No | No | Simple spreading when cache reuse is less important |
| **Weighted Cycle** | No | No | Yes | Proportional traffic distribution |

Session stickiness is applied before any strategy. If a warm session key is detected, the request is pinned to its current account regardless of the active strategy.

Note: the legacy `priority_spillover` and `highest_remaining_quota` strategies were removed when the router stopped estimating quota. Stored values for those strategies are mapped to `priority_failover` for backward compatibility.

## Routing Tape (Log Viewer)

Each log entry now includes rich metadata visible in the UI and file logs:

- Method, path, status code, and duration
- Selected key alias and why it was chosen
- Active strategy name
- Session ID (observed or synthesized from cache key)
- Token breakdown and upstream-observed cost (if reported)
- Whether the route was chosen by session stickiness
- For quota-error rows, a structured `quotaError` payload with the upstream's reset time and message

## Dashboard Control Room

The dashboard is organized into seven pages:

1. **Overview** — KPI strip (enabled / active / cooldown / requests / quota errors), an "Errors told us" panel listing the keys the upstream has marked exhausted (with the upstream's reset time and message), the live token-throughput chart, a model distribution donut, and the per-window token breakdown.
2. **Accounts** — Add, enable/drain, reorder (drag), and set priority/weight for each account. Each card shows its circuit-breaker state, quota-error tally, last quota error (status code, message, retry time), token breakdown, latency, error rate, last model, and a "Test" button that fires a live request through the proxy. Persistent to disk.
3. **Strategy Console** — Select an active strategy and see its description, best-for recommendation, cache friendliness, and behavior.
4. **Tokens** — Per-model and per-key time series, category share, observed cost, and 30-day rolling usage.
5. **Logs** — Virtualized table of every routed request, with the latest entry at the top. Search across path / model / key / route reason, filter by level / "Quota only" / provider (Go / Zen / All), pause auto-scroll, paginate for long histories, right-click to copy fields, click a row to see the full metadata.
6. **Models** — Browse the combined model catalog from both upstreams. Select which models show in the token charts. A drift banner lists free Zen models the upstream offers that are not in your `opencode.json` and provides a "Copy snippet" button to paste them in.
7. **Settings** — Active config (ports, strategy, total tokens observed, total observed cost, quota errors caught), the notification URL (ntfy.sh), the notification log, and the provider config snippet to copy into `~/.config/opencode/opencode.json`.

## Configuration

### Environment variables

Set these in your shell or service file. The app reads from `process.env` — it does not auto-load a `.env` file.

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM_URL` | `https://opencode.ai/zen/go/v1` | Upstream OpenCode Go API base URL |
| `DASHBOARD_PORT` | `18904` | Web UI dashboard port |
| `PROXY_PORT` | `18905` | Proxy server port |
| `COOLDOWN_MS` | `18000000` | Fallback cooldown in ms when the upstream returns 402/429 without a Retry-After signal. Default 5 hours. |
| `CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive 5xx errors before tripping |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `CONFIG_DIR` | `~/.opencode` | Directory for config, encrypted key storage, and usage data |
| `NTFY_URL` | — | Optional ntfy URL for push notifications (e.g., `https://ntfy.sh/mytopic`). Leave empty to disable. |
| `REQUEST_TIMEOUT_MS` | `0` | Wall-clock cap on the upstream HTTP round-trip in ms. `0` = disabled, matching OpenCode's no-timeout default for the opencode-go provider. |
| `UPSTREAM_HUNG_TIMEOUT_MS` | `0` | Safety net that aborts the upstream fetch if no response is received at all within this window. `0` = disabled. Cleared as soon as the upstream starts sending bytes. |

### Ports

- **18904** — Dashboard Web UI
- **18905** — Proxy/API endpoint

Both are configurable via environment variables.

## Architecture

```
┌──────────────┐     ┌──────────────────────────────────────┐
│  OpenCode    │────▶│  Go Router Proxy (port 18905)        │
│  CLI         │     │                                      │
└──────────────┘     │  KeyManager ──▶ CircuitBreaker       │
                     │       │              │                │
                     │  QuotaTracker   HeaderPassthrough     │
                     │       │              │                │
                     │  SecureStore    LogStream ──▶ Logger  │
                     └──────┬───────────────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│  OpenCode    │   │  OpenCode    │   │  Dashboard UI    │
│  Go API (A)  │   │  Go API (B)  │   │  (port 18904)    │
└──────────────┘   └──────────────┘   └──────────────────┘
```

1. OpenCode CLI points to the proxy at `localhost:18905`
2. OpenCode auto-loads the plugin at startup (plugin mode) and the plugin starts or reuses a shared detached local router daemon
3. Proxy selects an API key using the active strategy (with session stickiness as a pre-filter)
4. Request is forwarded to the upstream OpenCode Go API
5. On 402/429: key goes on dynamic cooldown, next key is tried
6. On 5xx: circuit breaker tracks consecutive errors, trips after threshold
7. Token usage is parsed from full JSON or SSE streaming responses and tracked against each key
8. Caching and session headers (`X-Session-Id`, `prompt_cache_key`, `cache_control`) pass through unmodified
9. All decisions are logged with routing reasons and streamed to the dashboard in real time

## Security

- **API keys are never stored in plain text.** They are encrypted with AES-256-GCM using a key derived from your machine's hostname and username via PBKDF2 with 600,000 iterations.
- The encrypted key file is stored at `~/.opencode/router-keys.enc` and is tied to your specific machine.
- **No keys are ever sent to any external service** — all processing is local.
- The dashboard runs on localhost only and is not exposed to the network.

## Push Notifications

Optional push notifications via [ntfy](https://ntfy.sh/) are sent when critical events happen.

Set the `NTFY_URL` environment variable to enable:

```bash
export NTFY_URL=https://ntfy.sh/mytopic
npm start
```

| Event | Priority | Trigger |
|---|---|---|
| Key quota exhausted | High / Urgent | A key returns 402/429 with a quota body, the router records the upstream-supplied cooldown and moves to the next key |
| All keys exhausted | Urgent | Every key in the pool is exhausted |
| Circuit breaker tripped | High | 3 consecutive 5xx errors, key removed from pool |
| Circuit breaker recovered | Low | Key is healthy again, back in the pool |

## OS Boot Service

If you want the router to start when the machine boots or when you log into your desktop session, run the standalone router under your OS service manager. Plugin mode alone only starts the router when OpenCode launches.

### Linux (`systemd`)

1. Build the project once:

```bash
cd /absolute/path/to/opencode-go-multi-auth
npm install
npm run build
```

2. Find your absolute Node path. If you use `nvm`, this matters because `systemd` will not load your interactive shell profile:

```bash
which node
```

3. Create `~/.config/systemd/user/opencode-go-router.service` and replace both absolute paths below:

- `WorkingDirectory` must be the repo root
- `ExecStart` must use the full path to your `node` binary and the full path to `dist/bin.js`

```ini
[Unit]
Description=OpenCode Go Multi-Account Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/opencode-go-multi-auth
ExecStart=/absolute/path/to/node /absolute/path/to/opencode-go-multi-auth/dist/bin.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

4. Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-go-router.service
```

5. Verify it:

```bash
systemctl --user status opencode-go-router.service --no-pager
curl http://127.0.0.1:18904/healthz
curl http://127.0.0.1:18905/v1/models
```

6. If you rebuild or change the source later, rebuild and restart the service:

```bash
npm run build
systemctl --user restart opencode-go-router.service
```

7. Point OpenCode at the same proxy config from the earlier README section. With this setup, OpenCode can reuse the already-running router after login or reboot.

### Notes

- This is a user service, so it starts when your user session starts.
- If you want it to run before login, you would need system-level service configuration and user lingering, which is usually unnecessary for this app.
- If `which node` prints an `nvm` path, use that exact path in `ExecStart`.

### macOS (`launchd`)

Use the standalone router with a user `LaunchAgent` that runs `node /absolute/path/to/opencode-go-multi-auth/dist/bin.js` in the repo directory. The important part is the same: build first, use absolute paths, and manage `dist/bin.js` as a long-running user service.

## Development

```bash
# Watch mode with auto-reload
npm run dev

# TypeScript type checking
npm run typecheck

# Build
npm run build

# Clean build output
npm run clean
```

## Plugin Notes

- OpenCode plugin mode is the preferred installation path.
- The plugin starts or reuses one shared local router daemon across OpenCode sessions, so opening multiple sessions should not create competing proxy/dashboard owners.
- The plugin does not replace the built-in `opencode-go` provider. It auto-starts the proxy; the provider still needs the one-time `baseURL` override in `opencode.json`.
- Plugin mode auto-starts the router when OpenCode launches. It does not create an OS boot service; if you want system boot behavior, run the standalone router under `systemd`, `launchd`, or another service manager.
- Standalone CLI mode remains available for debugging, system service setups, or running the router outside OpenCode.

## Programmatic Usage

You can also use the router as a library:

```typescript
import { createRouter } from 'opencode-go-multi-auth'

const router = await createRouter({
  proxyPort: 18905,
  dashboardPort: 18904,
})

// Access internal components
router.keyManager.addKey('sk-...', 'Primary')
router.circuitBreaker.getState('key-id')
router.quotaTracker.getUsage('key-id')

// Graceful shutdown
await router.shutdown()
```

## License

MIT
