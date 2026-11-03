import type { ApiKey, KeyUsage } from '../router/types.js'
import { UsageClient } from './usage-client.js'

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 15_000
const MAX_BACKOFF_MS = 10 * 60_000
const FIRST_POLL_STAGGER_MS = 2_000
const KEY_SYNC_INTERVAL_MS = 5_000

export interface UsagePollerOptions {
  intervalMs?: number
  getKeys: () => ApiKey[]
  onChange?: () => void
  syncIntervalMs?: number
  staggerMs?: number
}

interface KeySchedule {
  timer: NodeJS.Timeout | null
  failures: number
}

export class UsagePoller {
  private readonly client: UsageClient
  private readonly intervalMs: number
  private readonly getKeys: () => ApiKey[]
  private readonly onChange?: () => void
  private readonly syncIntervalMs: number
  private readonly staggerMs: number
  private readonly usage = new Map<string, KeyUsage>()
  private readonly schedules = new Map<string, KeySchedule>()
  private syncTimer: NodeJS.Timeout | null = null
  private started = false

  constructor(client: UsageClient, options: UsagePollerOptions) {
    this.client = client
    const requested = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.intervalMs = requested > 0 ? Math.max(MIN_INTERVAL_MS, Math.floor(requested)) : 0
    this.getKeys = options.getKeys
    this.onChange = options.onChange
    this.syncIntervalMs = Math.max(1, Math.floor(options.syncIntervalMs ?? KEY_SYNC_INTERVAL_MS))
    this.staggerMs = Math.max(0, Math.floor(options.staggerMs ?? FIRST_POLL_STAGGER_MS))
  }

  loadUsage(keyId: string, usage: KeyUsage | null | undefined): void {
    if (usage && typeof usage.fetchedAt === 'string') {
      this.usage.set(keyId, usage)
    }
  }

  start(): void {
    if (this.started || this.intervalMs === 0) return
    this.started = true
    this.getKeys().forEach((key, index) => this.schedule(key, index * this.staggerMs))
    // New keys can appear after boot (dashboard add); sync independently of polls
    // so a router started with zero keys still starts polling them.
    this.syncTimer = setInterval(() => this.syncKeys(), this.syncIntervalMs)
  }

  stop(): void {
    this.started = false
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    for (const schedule of this.schedules.values()) {
      if (schedule.timer) clearTimeout(schedule.timer)
    }
    this.schedules.clear()
  }

  getUsage(keyId: string): KeyUsage | null {
    return this.usage.get(keyId) ?? null
  }

  async pollKey(key: ApiKey): Promise<KeyUsage> {
    try {
      const snapshot = await this.client.fetchUsage(key.key)
      const previous = this.usage.get(key.id)
      // A partial payload must not erase a window that was known before.
      const usage: KeyUsage = {
        rolling: snapshot.rolling ?? previous?.rolling ?? null,
        weekly: snapshot.weekly ?? previous?.weekly ?? null,
        monthly: snapshot.monthly ?? previous?.monthly ?? null,
        fetchedAt: new Date().toISOString(),
        error: null,
      }
      this.usage.set(key.id, usage)
      this.onChange?.()
      return usage
    } catch (error) {
      // Keep the last good windows; only the error marker changes.
      const previous = this.usage.get(key.id)
      const usage: KeyUsage = {
        rolling: previous?.rolling ?? null,
        weekly: previous?.weekly ?? null,
        monthly: previous?.monthly ?? null,
        // Epoch marks "never fetched successfully"; windows stay empty in that case.
        fetchedAt: previous?.fetchedAt ?? new Date(0).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
      this.usage.set(key.id, usage)
      this.onChange?.()
      return usage
    }
  }

  private schedule(key: ApiKey, delayMs: number): void {
    if (!this.started) return

    let schedule = this.schedules.get(key.id)
    if (!schedule) {
      schedule = { timer: null, failures: 0 }
      this.schedules.set(key.id, schedule)
    }
    if (schedule.timer) clearTimeout(schedule.timer)

    const current = schedule
    current.timer = setTimeout(() => {
      current.timer = null
      void this.runPoll(key, current)
    }, delayMs)
  }

  private async runPoll(key: ApiKey, schedule: KeySchedule): Promise<void> {
    if (!this.started) return

    try {
      const usage = await this.pollKey(key)
      if (!this.started) return
      schedule.failures = usage.error ? schedule.failures + 1 : 0
      this.schedule(key, this.nextDelay(schedule.failures))
    } catch {
      // pollKey converts fetch errors into KeyUsage.error; this guards the timer
      // against anything unexpected so it can never become an unhandled rejection.
      if (!this.started) return
      schedule.failures += 1
      this.schedule(key, this.nextDelay(schedule.failures))
    }
  }

  private syncKeys(): void {
    if (!this.started) return

    const keys = this.getKeys()
    const ids = new Set(keys.map((key) => key.id))
    for (const [id, schedule] of this.schedules) {
      if (!ids.has(id)) {
        if (schedule.timer) clearTimeout(schedule.timer)
        this.schedules.delete(id)
      }
    }
    for (const key of keys) {
      if (!this.schedules.has(key.id)) {
        this.schedule(key, this.staggerMs)
      }
    }
  }

  private nextDelay(failures: number): number {
    if (failures === 0) return this.intervalMs
    return Math.min(this.intervalMs * 2 ** failures, MAX_BACKOFF_MS)
  }
}
