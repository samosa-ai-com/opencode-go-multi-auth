import express, { type NextFunction, type Request, type Response } from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KeyManager } from '../router/key-manager.js'
import type { CircuitBreaker } from '../router/circuit-breaker.js'
import type { QuotaTracker } from '../router/quota-tracker.js'
import { LogStream } from '../logging/log-stream.js'
import { logToFile } from '../logging/logger.js'
import { SecureStore } from '../storage/secure-store.js'
import { ConfigStore } from '../storage/config-store.js'
import { NtfyNotifier } from '../notification/ntfy.js'
import { OpenCodeUsageStore } from '../storage/opencode-usage-store.js'
import type { UsagePoller } from '../usage/usage-poller.js'
import {
  RoutingStrategy,
  ROUTING_STRATEGIES,
  normalizeRoutingStrategy,
  type ApiKey,
} from '../router/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')

const FETCH_TIMEOUT_MS = 8_000

async function fetchJson(url: string, signal: AbortSignal): Promise<{ data?: Array<{ id?: string }> }> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`upstream returned HTTP ${res.status}`)
  return res.json() as Promise<{ data?: Array<{ id?: string }> }>
}

function resolveOpenCodeConfigPath(): string {
  return process.env.OPENCODE_CONFIG
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json')
}

function readOpenCodeConfig(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(resolveOpenCodeConfigPath(), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

type AsyncHandler = (req: express.Request<any>, res: Response, next: NextFunction) => Promise<void>

function wrap(handler: AsyncHandler): express.RequestHandler {
  return (req, res, next) => handler(req as any, res, next).catch(next)
}

export class DashboardServer {
  private app: express.Application
  private server?: http.Server
  private readonly port: number
  private readonly openCodeUsageStore: OpenCodeUsageStore

  constructor(
    port: number,
    private proxyPort: number,
    private keyManager: KeyManager,
    private circuitBreaker: CircuitBreaker,
    private quotaTracker: QuotaTracker,
    private logStream: LogStream,
    private secureStore: SecureStore,
    private configStore: ConfigStore,
    private notifier: NtfyNotifier,
    private usagePoller: UsagePoller,
  ) {
    this.port = port
    this.openCodeUsageStore = new OpenCodeUsageStore()
    this.app = express()
    this.app.use(express.json())
    this.setupRoutes()
  }

  private setupRoutes(): void {
    this.app.use(express.static(PUBLIC_DIR))

    this.app.get('/favicon.ico', (_req, res) => {
      res.redirect('/favicon.svg')
    })

    this.app.get('/healthz', (_req, res) => {
      res.json({
        ok: true,
        keys: this.keyManager.getKeys().length,
        activeKeys: this.keyManager.getActiveKeys().length,
      })
    })

    this.app.get('/api/keys', wrap(async (_req, res) => {
      res.json(this.serializeKeys())
    }))

    this.app.post('/api/keys', wrap(async (req, res) => {
      const { key, alias, priority, weight, enabled } = req.body
      if (!key || typeof key !== 'string') {
        res.status(400).json({ error: 'Key is required' })
        return
      }

      const entry = this.keyManager.addKey(key, alias || undefined, {
        enabled: typeof enabled === 'boolean' ? enabled : true,
        priority: typeof priority === 'number' ? priority : 1,
        weight: typeof weight === 'number' ? weight : 1,
      })
      await this.persistKeys()
      res.json(this.serializeKey(entry))
    }))

    this.app.put('/api/keys/reorder', wrap(async (req, res) => {
      const order = Array.isArray(req.body?.order) ? req.body.order.filter((v: unknown) => typeof v === 'string') : null
      if (!order) {
        res.status(400).json({ error: 'order must be an array of key ids' })
        return
      }
      const ok = this.keyManager.reorderKeys(order)
      if (!ok) {
        res.status(400).json({ error: 'Invalid order: must include every key id exactly once' })
        return
      }
      await this.persistKeys()
      res.json(this.serializeKeys())
    }))

    this.app.put('/api/keys/:id/toggle', wrap(async (req, res) => {
      const enabled = typeof req.body?.enabled === 'boolean'
        ? req.body.enabled
        : !this.keyManager.getKeyById(req.params.id)?.enabled

      const updated = this.keyManager.setEnabled(req.params.id, enabled)
      if (!updated) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      await this.persistKeys()
      res.json(this.serializeKey(updated))
    }))

    this.app.post('/api/keys/:id/reset-cooldown', wrap(async (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      this.keyManager.resetCooldown(req.params.id)
      res.json(this.serializeKey(key))
    }))

    this.app.put('/api/keys/:id/key', wrap(async (req, res) => {
      const newKey = typeof req.body?.key === 'string' ? req.body.key : ''
      if (!newKey.trim()) {
        res.status(400).json({ error: 'Key is required' })
        return
      }
      const updated = this.keyManager.setKeyMaterial(req.params.id, newKey)
      if (!updated) {
        res.status(404).json({ error: 'Key not found' })
        return
      }
      await this.persistKeys()
      res.json(this.serializeKey(updated))
    }))

    this.app.put('/api/keys/:id', wrap(async (req, res) => {
      const { alias, enabled, priority, weight } = req.body ?? {}
      const updated = this.keyManager.updateKeySettings(req.params.id, {
        alias,
        enabled,
        priority,
        weight,
      })
      if (!updated) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      await this.persistKeys()
      res.json(this.serializeKey(updated))
    }))

    this.app.delete('/api/keys/:id', wrap(async (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }

      this.keyManager.removeKey(req.params.id)
      await this.secureStore.removeKey(req.params.id)
      res.json({ success: true })
    }))

    this.app.get('/api/strategy', (_req, res) => {
      const strategy = normalizeRoutingStrategy(this.configStore.get('strategy'))
      res.json({ strategy })
    })

    this.app.get('/api/strategies', (_req, res) => {
      res.json({ strategies: ROUTING_STRATEGIES })
    })

    this.app.put('/api/strategy', (req, res) => {
      const strategy = normalizeRoutingStrategy(req.body?.strategy)
      if (!Object.values(RoutingStrategy).includes(strategy)) {
        res.status(400).json({ error: 'Invalid strategy' })
        return
      }
      this.configStore.set('strategy', strategy)
      res.json({ strategy })
    })

    this.app.get('/api/config', (_req, res) => {
      const config = this.configStore.getAll()
      res.json({ ntfyUrl: config.ntfyUrl })
    })

    this.app.put('/api/config', (req, res) => {
      const { ntfyUrl } = req.body ?? {}
      if (typeof ntfyUrl !== 'string') {
        res.status(400).json({ error: 'ntfyUrl must be a string' })
        return
      }
      this.configStore.set('ntfyUrl', ntfyUrl as any)
      this.notifier.updateUrl(ntfyUrl)
      res.json({ ntfyUrl })
    })

    this.app.get('/api/models', async (_req, res) => {
      try {
        const proxy = `http://127.0.0.1:${this.proxyPort}`
        const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
        const [goRes, zenRes] = await Promise.allSettled([
          fetchJson(`${proxy}/v1/models`, signal).then(j => (j.data || []).map(m => m.id).filter(Boolean) as string[]),
          fetchJson(`${proxy}/zen/v1/models`, signal).then(j => (j.data || []).map(m => m.id).filter(Boolean) as string[]),
        ])
        res.json({
          go: goRes.status === 'fulfilled' ? goRes.value : [],
          zen: zenRes.status === 'fulfilled' ? zenRes.value : [],
        })
      } catch {
        res.status(500).json({ error: 'Failed to fetch models' })
      }
    })

    this.app.get('/api/zen-provider-models', async (req, res) => {
      const providerName = String(req.query.provider || '').trim() || 'multi-auth-zen'
      const proxy = `http://127.0.0.1:${this.proxyPort}`
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

      // Read the configured model list from the user's opencode.json
      const cfg = readOpenCodeConfig()
      const providerBlock = (cfg?.provider as Record<string, unknown> | undefined)?.[providerName] as
        | { models?: Record<string, unknown> }
        | undefined
      const configured = providerBlock && providerBlock.models && typeof providerBlock.models === 'object'
        ? Object.keys(providerBlock.models)
        : []
      const providerMissing = !providerBlock

      // Fetch the live catalog from the proxy's /zen/v1/models endpoint
      let live: string[] = []
      let liveError: string | null = null
      try {
        const json = await fetchJson(`${proxy}/zen/v1/models`, signal)
        live = (json.data || []).map(m => m.id).filter(Boolean) as string[]
      } catch (err) {
        liveError = err instanceof Error ? err.message : String(err)
      }

      const configuredSet = new Set(configured)
      const liveSet = new Set(live)
      const missing = live.filter(m => !configuredSet.has(m)).sort()
      const stale = configured.filter(m => !liveSet.has(m)).sort()

      res.json({
        provider: providerName,
        configured,
        live,
        missing,
        stale,
        providerMissing,
        liveError,
        lastCheckAt: Date.now(),
      })
    })

    this.app.get('/api/visible-models', (_req, res) => {
      const raw = this.configStore.get('visibleModels') as string || ''
      const models = raw ? raw.split(',').filter(Boolean) : []
      res.json({ models })
    })

    this.app.put('/api/visible-models', (req, res) => {
      const { models } = req.body ?? {}
      if (!Array.isArray(models)) {
        res.status(400).json({ error: 'models must be an array' })
        return
      }
      this.configStore.set('visibleModels', models.join(','))
      res.json({ models })
    })

    this.app.get('/api/notifications', (_req, res) => {
      res.json(this.notifier.getHistory())
    })

    this.app.post('/api/keys/:id/test', async (req, res) => {
      const key = this.keyManager.getKeyById(req.params.id)
      if (!key) {
        res.status(404).json({ error: 'Key not found' })
        return
      }
      const start = Date.now()
      try {
        const upstreamRes = await fetch(`http://127.0.0.1:${this.proxyPort}/v1/models`, {
          headers: {
            'x-api-key': key.key,
            'Authorization': `Bearer ${key.key}`,
          },
          signal: AbortSignal.timeout(10000),
        })
        const duration = Date.now() - start
        res.json({ ok: upstreamRes.ok, status: upstreamRes.status, latencyMs: duration })
      } catch (err) {
        const duration = Date.now() - start
        res.json({ ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: duration })
      }
    })

    this.app.get('/api/status', (_req, res) => {
      const keys = this.serializeKeys()
      const actualUsage = this.openCodeUsageStore.getSummary()
      const summary = {
        totalKeys: keys.length,
        enabledKeys: keys.filter((key) => key.enabled).length,
        activeKeys: keys.filter((key) => key.enabled && key.status === 'active').length,
        cooldownKeys: keys.filter((key) => key.status === 'cooldown').length,
        totalRequests: keys.reduce((sum, key) => sum + key.requestCount, 0),
        totalTokens: keys.reduce((sum, key) => sum + key.tokensUsed, 0),
        observedCost: keys.reduce((sum, key) => sum + (key.costAccumulated || 0), 0),
        quotaErrorCount: keys.reduce((sum, key) => sum + (key.quotaErrorCount || 0), 0),
        actualUsage,
      }
      res.json({ summary, keys })
    })

    this.app.get('/api/logs', (_req, res) => {
      res.json(this.logStream.getRecentLogs())
    })

    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err)
      logToFile('error', 'API error', { error: message })
      if (!res.headersSent) {
        res.status(500).json({ error: message })
      }
    })
  }

  async start(): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        resolve(this.server!)
      })
      this.server.on('error', (err) => reject(err))
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private async persistKeys(): Promise<void> {
    await this.secureStore.saveKeys(this.keyManager.toStoredEntries())
  }

  private serializeKeys() {
    return this.keyManager.getKeys().map((key) => this.serializeKey(key))
  }

  private serializeKey(key: ApiKey) {
    const quota = this.quotaTracker.getUsageBreakdown(key.id)
    const last7d = this.quotaTracker.getWindowedUsage(key.id, 7 * 24 * 60 * 60 * 1000)
    const last30d = this.quotaTracker.getWindowedUsage(key.id, 30 * 24 * 60 * 60 * 1000)
    const calendarMonth = this.quotaTracker.getCalendarMonthUsage(key.id)
    key.tokensUsed = quota.totalTokens
    key.costAccumulated = quota.costAccumulated

    return {
      id: key.id,
      alias: key.alias,
      masked: `****${key.key.slice(-4)}`,
      status: key.status,
      enabled: key.enabled,
      priority: key.priority,
      weight: key.weight,
      addedAt: key.addedAt,
      cooldownUntil: key.cooldownUntil,
      health: this.circuitBreaker.getState(key.id),
      requestCount: key.requestCount,
      successCount: key.successCount,
      errorCount: key.errorCount,
      averageLatencyMs: key.averageLatencyMs,
      lastUsedAt: key.lastUsedAt,
      lastStatusCode: key.lastStatusCode,
      lastModel: key.lastModel,
      lastSessionId: key.lastSessionId,
      tokensUsed: quota.totalTokens,
      costAccumulated: quota.costAccumulated,
      quotaErrorCount: key.quotaErrorCount,
      lastQuotaError: key.lastQuotaError,
      usage: this.usagePoller.getUsage(key.id),
      quota,
      recentUsage: {
        last7d,
        last30d,
        calendarMonth,
      },
    }
  }
}
