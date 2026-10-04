import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Plugin as V1Plugin, PluginModule } from '@opencode-ai/plugin'
import { Plugin as V2Plugin } from '@opencode/plugin'
import { DEFAULT_CONFIG } from './router/types.js'
import { setPluginMode, logToFile } from './logging/logger.js'
import { getRuntimePaths, isProcessAlive, readPidState } from './runtime/daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function getProxyPort(): number {
  return Number(process.env.PROXY_PORT) || DEFAULT_CONFIG.proxyPort
}

function getDashboardPort(): number {
  return Number(process.env.DASHBOARD_PORT) || DEFAULT_CONFIG.dashboardPort
}

function getHealthUrl(): string {
  return `http://127.0.0.1:${getDashboardPort()}/healthz`
}

async function isDashboardHealthy(): Promise<boolean> {
  try {
    const res = await fetch(getHealthUrl(), {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function isProxyListening(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const done = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(getProxyPort(), '127.0.0.1')
  })
}

async function isRouterHealthy(): Promise<boolean> {
  const [dashboardHealthy, proxyListening] = await Promise.all([
    isDashboardHealthy(),
    isProxyListening(),
  ])
  return dashboardHealthy && proxyListening
}

function removeBootstrapLock(): void {
  try {
    const { bootstrapLockFile } = getRuntimePaths()
    if (fs.existsSync(bootstrapLockFile)) {
      fs.unlinkSync(bootstrapLockFile)
    }
  } catch (error) {
    logToFile('warn', 'Failed to remove bootstrap lock file.', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function readBootstrapLogTail(): string | null {
  try {
    const { bootstrapLogFile } = getRuntimePaths()
    if (!fs.existsSync(bootstrapLogFile)) return null
    const content = fs.readFileSync(bootstrapLogFile, 'utf8')
    if (!content) return null
    const lines = content.trim().split('\n')
    return lines.slice(-10).join('\n')
  } catch {
    return null
  }
}

async function waitForRouterHealthy(timeoutMs: number, daemonPid?: number): Promise<{ healthy: boolean, childExited: boolean }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isRouterHealthy()) return { healthy: true, childExited: false }
    if (daemonPid && !isProcessAlive(daemonPid)) return { healthy: false, childExited: true }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { healthy: false, childExited: daemonPid ? !isProcessAlive(daemonPid) : false }
}

function getDaemonEntry(): string {
  if (path.basename(__dirname) === 'src') {
    return path.join(__dirname, 'bin.ts')
  }
  return path.join(__dirname, 'bin.js')
}

function spawnRouterDaemon(): number {
  const { bootstrapLogFile } = getRuntimePaths()
  const entry = getDaemonEntry()
  const logFd = fs.openSync(bootstrapLogFile, 'a')

  if (!fs.existsSync(entry)) {
    fs.writeSync(logFd, `Error: Daemon entry not found at ${entry}\n`)
    fs.closeSync(logFd)
    return 0
  }

  // process.execPath may be 'npx' when loaded via some plugin loaders
  const nodeBin = path.basename(process.execPath) === 'node'
    ? process.execPath
    : 'node'

  const child = spawn(nodeBin, [entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      OPENCODE_ROUTER_PLUGIN_MODE: '1',
    },
  })
  fs.closeSync(logFd)

  child.on('error', (err) => {
    const { bootstrapLogFile: logFile } = getRuntimePaths()
    try {
      fs.appendFileSync(logFile, `Error: spawn failed — ${err.message}\n`)
    } catch { /* ignore */ }
  })

  child.unref()
  return child.pid ?? 0
}

function tryAcquireBootstrapLock(): boolean {
  const { bootstrapLockFile } = getRuntimePaths()
  try {
    const fd = fs.openSync(bootstrapLockFile, 'wx')
    fs.writeFileSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

async function ensureRouterDaemon(): Promise<'reused' | 'started' | 'failed'> {
  if (await isRouterHealthy()) {
    const state = readPidState()
    logToFile('info', 'Reusing running router daemon.', {
      pid: state?.pid ?? null,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
    })
    return 'reused'
  }

  const existingState = readPidState()
  if (existingState && !isProcessAlive(existingState.pid)) {
    logToFile('warn', 'Removing stale router pid file before restart.', { pid: existingState.pid })
    const { pidFile } = getRuntimePaths()
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
    } catch { /* ignore */ }
  }

  const { bootstrapLockFile } = getRuntimePaths()
  if (fs.existsSync(bootstrapLockFile)) {
    try {
      const lockPid = Number(fs.readFileSync(bootstrapLockFile, 'utf8').trim())
      if (!isProcessAlive(lockPid)) {
        logToFile('warn', 'Removing stale bootstrap lock from dead process.', { pid: lockPid })
        fs.unlinkSync(bootstrapLockFile)
      }
    } catch {
      fs.unlinkSync(bootstrapLockFile)
    }
  }

  if (!tryAcquireBootstrapLock()) {
    const waited = await waitForRouterHealthy(30_000)
    if (waited.healthy) {
      const state = readPidState()
      logToFile('info', 'Router daemon became healthy while waiting for another bootstrapper.', {
        pid: state?.pid ?? null,
      })
      return 'reused'
    }

    logToFile('error', 'Router bootstrap lock was held but the daemon never became healthy.', {
      healthUrl: getHealthUrl(),
      proxyPort: getProxyPort(),
      bootstrapLogTail: readBootstrapLogTail(),
    })
    return 'failed'
  }

  try {
    if (await isRouterHealthy()) {
      return 'reused'
    }

    const pid = spawnRouterDaemon()
    if (pid === 0) {
      logToFile('error', 'Failed to spawn router daemon (daemon entry not found).', {
        daemonEntry: getDaemonEntry(),
        bootstrapLogTail: readBootstrapLogTail(),
      })
      return 'failed'
    }

    logToFile('info', 'Started router daemon bootstrap.', {
      pid,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
      healthUrl: getHealthUrl(),
    })

    const waited = await waitForRouterHealthy(30_000, pid)
    if (!waited.healthy) {
      logToFile('error', waited.childExited
        ? 'Router daemon exited before becoming healthy.'
        : 'Router daemon failed to become healthy before timeout.', {
        pid,
        healthUrl: getHealthUrl(),
        proxyPort: getProxyPort(),
        bootstrapLogTail: readBootstrapLogTail(),
      })

      if (waited.childExited) {
        const { bootstrapLockFile: lockFile } = getRuntimePaths()
        if (fs.existsSync(lockFile)) {
          try { fs.unlinkSync(lockFile) } catch { /* ignore */ }
        }
        logToFile('info', 'Retrying daemon start after cleaning stale state.')
        return ensureRouterDaemon()
      }

      return 'failed'
    }

    const state = readPidState()
    logToFile('info', 'Router daemon is healthy and ready.', {
      pid: state?.pid ?? pid,
      dashboardPort: getDashboardPort(),
      proxyPort: getProxyPort(),
    })
    return 'started'
  } finally {
    removeBootstrapLock()
  }
}

const OpenCodeGoMultiAuthPlugin: V1Plugin = async ({ client }) => {
  setPluginMode(true)
  const status = await ensureRouterDaemon()

  await client.app.log({
    body: {
      service: 'opencode-go-multi-auth',
      level: status === 'failed' ? 'error' : 'info',
      message: status === 'started'
        ? 'Multi-auth router daemon started.'
        : status === 'reused'
          ? 'Multi-auth router daemon reused.'
          : 'Multi-auth router daemon failed to start.',
    },
  }).catch(() => {})

  return {
    dispose: async () => {
      // Shared daemon stays alive across OpenCode session exits.
    },
  }
}

export const server = OpenCodeGoMultiAuthPlugin
export const pluginModule: PluginModule = {
  id: 'opencode-go-multi-auth',
  server: OpenCodeGoMultiAuthPlugin,
}

// OpenCode V2 requires a definition object ({ id, setup }) as the default
// export; the V1 server() is kept on the same object so one build serves both
// loaders (V1 >= 1.18.29 and V2). See docs: opencode.ai/v2/docs/build/plugins/migrate-v1
export default {
  ...V2Plugin.define({
    id: 'opencode-go-multi-auth',
    async setup() {
      setPluginMode(true)
      const status = await ensureRouterDaemon()
      console.log(`[opencode-go-multi-auth] router daemon ${status}.`)
      // The shared daemon intentionally outlives the plugin; no cleanup.
    },
  }),
  server: OpenCodeGoMultiAuthPlugin,
}
