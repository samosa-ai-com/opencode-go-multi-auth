import type { ApiKey, KeyUsage } from '../router/types.js'
import { UsageClient } from './usage-client.js'

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 15_000
const MAX_BACKOFF_MS = 10 * 60_000
const FIRST_POLL_STAGGER_MS = 2_000

export interface UsagePollerOptions {
  intervalMs?: number
  getKeys: () => ApiKey[]
  onChange?: () => void
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
  private readonly usage = new Map<string, KeyUsage>()
  private readonly schedules = new Map<string, KeySchedule>()
  private started = false

  constructor(client: UsageClient, options: UsagePollerOptions) {
    this.client = client
    const requested = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.intervalMs = requested > 0 ? Math.max(MIN_INTERVAL_MS, Math.floor(requested)) : 0
    this.getKeys = options.getKeys
    this.onChange = options.onChange
  }

  loadUsage(alias: string, usage: KeyUsage | null | undefined): void {
    if (usage && typeof usage.fetchedAt === 'string') {
      this.usage.set(alias, usage)
    }
  }

  start(): void {
    if (this.started || this.intervalMs === 0) return
    this.started = true
    this.getKeys().forEach((key, index) => this.schedule(key, index * FIRST_POLL_STAGGER_MS))
  }

  stop(): void {
    this.started = false
    for (const schedule of this.schedules.values()) {
      if (schedule.timer) clearTimeout(schedule.timer)
    }
    this.schedules.clear()
  }

  getUsage(keyAlias: string): KeyUsage | null {
    return this.usage.get(keyAlias) ?? null
  }

  async pollKey(key: ApiKey): Promise<KeyUsage> {
    try {
      const snapshot = await this.client.fetchUsage(key.key)
      const usage: KeyUsage = {
        ...snapshot,
        fetchedAt: new Date().toISOString(),
        error: null,
      }
      this.usage.set(key.alias, usage)
      this.onChange?.()
      return usage
    } catch (error) {
      // Keep the last good windows; only the error marker changes.
      const previous = this.usage.get(key.alias)
      const usage: KeyUsage = {
        rolling: previous?.rolling ?? null,
        weekly: previous?.weekly ?? null,
        monthly: previous?.monthly ?? null,
        // Epoch marks "never fetched successfully"; windows stay empty in that case.
        fetchedAt: previous?.fetchedAt ?? new Date(0).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
      this.usage.set(key.alias, usage)
      this.onChange?.()
      return usage
    }
  }

  private schedule(key: ApiKey, delayMs: number): void {
    if (!this.started) return

    let schedule = this.schedules.get(key.alias)
    if (!schedule) {
      schedule = { timer: null, failures: 0 }
      this.schedules.set(key.alias, schedule)
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
      this.syncKeys()
    } catch {
      // pollKey converts fetch errors into KeyUsage.error; this guards the timer
      // against anything unexpected so it can never become an unhandled rejection.
      if (!this.started) return
      schedule.failures += 1
      this.schedule(key, this.nextDelay(schedule.failures))
    }
  }

  private syncKeys(): void {
    const keys = this.getKeys()
    const aliases = new Set(keys.map((key) => key.alias))
    for (const [alias, schedule] of this.schedules) {
      if (!aliases.has(alias)) {
        if (schedule.timer) clearTimeout(schedule.timer)
        this.schedules.delete(alias)
      }
    }
    for (const key of keys) {
      if (!this.schedules.has(key.alias)) {
        this.schedule(key, FIRST_POLL_STAGGER_MS)
      }
    }
  }

  private nextDelay(failures: number): number {
    if (failures === 0) return this.intervalMs
    return Math.min(this.intervalMs * 2 ** failures, MAX_BACKOFF_MS)
  }
}
