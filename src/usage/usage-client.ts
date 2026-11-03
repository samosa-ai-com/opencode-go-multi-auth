import type { KeyUsage, UsageWindow } from '../router/types.js'

export type UsageSnapshot = Pick<KeyUsage, 'rolling' | 'weekly' | 'monthly'>

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ERROR_LENGTH = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parsePercent(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.min(100, Math.max(0, parsed))
}

function parseResetsAt(raw: Record<string, unknown>, now: number): string | null {
  if (typeof raw.resetsAt === 'string' && raw.resetsAt.trim()) {
    const parsed = Date.parse(raw.resetsAt)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  // Legacy payloads report a relative number of seconds instead of an ISO timestamp.
  const resetInSec = typeof raw.resetInSec === 'number' ? raw.resetInSec : Number.NaN
  if (Number.isFinite(resetInSec) && resetInSec >= 0) {
    return new Date(now + resetInSec * 1000).toISOString()
  }
  return null
}

function parseWindow(value: unknown, now: number): UsageWindow | null {
  const raw = asRecord(value)
  if (!raw) return null

  const usedPercent = parsePercent(raw.percent ?? raw.usedPercent)
  if (usedPercent === null) return null

  return {
    usedPercent,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    resetsAt: parseResetsAt(raw, now),
  }
}

function describeErrorBody(body: string): string {
  if (!body.trim()) return ''
  try {
    const root = asRecord(JSON.parse(body) as unknown)
    if (!root) return body

    const error = asRecord(root.error)
    if (error) {
      const type = typeof error.type === 'string' ? error.type : ''
      const message = typeof error.message === 'string' ? error.message : ''
      const detail = [type, message].filter(Boolean).join(': ')
      if (detail) return detail
    }
    if (typeof root.error === 'string' && root.error.trim()) return root.error
    if (typeof root.message === 'string') return root.message
    return body
  } catch {
    return body
  }
}

export class UsageClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  async fetchUsage(apiKey: string): Promise<UsageSnapshot> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}/usage`, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const detail = describeErrorBody(body).slice(0, MAX_ERROR_LENGTH)
        const suffix = detail ? `: ${detail}` : ''
        throw new Error(`Usage endpoint returned HTTP ${response.status}${suffix}`.slice(0, MAX_ERROR_LENGTH))
      }

      const payload = await response.json().catch(() => null)
      const root = asRecord(payload)
      if (!root) {
        throw new Error('Usage endpoint returned an invalid JSON payload')
      }

      // The documented shape wraps windows in "usage"; accept a bare shape too.
      const usage = asRecord(root.usage) ?? root
      const now = Date.now()
      return {
        rolling: parseWindow(usage.rolling, now),
        weekly: parseWindow(usage.weekly, now),
        monthly: parseWindow(usage.monthly, now),
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Usage request timed out after ${this.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
