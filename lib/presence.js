// Which Claude Code sessions run walink, and which of them receive phone messages (channels).
// Claude Code doesn't tell an MCP server whether it was started with channels, so we read the flag
// from the parent process's command line (walink is spawned directly by claude).
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isAlive, startHeartbeat } from './lock.js'
import { writeJsonAtomic } from './persist.js'

export const CHANNELS_CMD = 'claude --dangerously-load-development-channels plugin:walink@walink'
const FLAGS = new Set(['--dangerously-load-development-channels', '--channels'])
const STALE_MS = 30_000 // registry files are touched every 5s, like the lock

// cmdline: a Windows/ps command line string, or an argv array (/proc).
// ponytail: matches any channel entry naming "walink"; the server can't know the name it was configured under.
export function channelsFlag(cmdline) {
  const tokens = Array.isArray(cmdline) ? cmdline : (String(cmdline ?? '').match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''))
  for (let i = 0; i < tokens.length; i++) {
    const [flag, inline] = tokens[i].split(/=(.*)/s)
    if (!FLAGS.has(flag)) continue
    const values = inline !== undefined ? [inline] : []
    for (let j = i + 1; inline === undefined && j < tokens.length && !tokens[j].startsWith('-'); j++) values.push(tokens[j])
    if (values.flatMap((v) => v.split(',')).some((v) => /walink/i.test(v))) return true
  }
  return false
}

const run = promisify(execFile)
async function parentCmdline(ppid, platform) {
  if (platform === 'linux') return (await readFile(`/proc/${ppid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
  const [cmd, args] =
    platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(ppid)}').CommandLine`]]
      : ['ps', ['-o', 'args=', '-p', String(ppid)]]
  return (await run(cmd, args, { timeout: 5_000, windowsHide: true })).stdout.trim()
}

// true | false | null (couldn't tell). WALINK_CHANNELS=1|0 overrides when detection gets it wrong.
export async function detectChannels({ env = process.env, ppid = process.ppid, platform = process.platform, readCmdline = parentCmdline } = {}) {
  if (env.WALINK_CHANNELS === '1') return true
  if (env.WALINK_CHANNELS === '0') return false
  try {
    const c = await readCmdline(ppid, platform)
    return c?.length ? channelsFlag(c) : null
  } catch {
    return null
  }
}

// A listening session takes WhatsApp from an owner that isn't known to listen. Never from another listener
// (the first keeps it), and a non-listening session never reclaims, so ownership can't ping-pong.
export function shouldReclaim({ listening, holderPid, sessions, pid = process.pid }) {
  if (listening !== true || !holderPid || holderPid === pid) return false
  return !sessions.some((s) => s.pid === holderPid && s.channels === true)
}

// Registry: <dir>/sessions/<pid>.json = { pid, label, startedAt, channels }, heartbeat-touched while alive.
export function createPresence(dir, { pid = process.pid, now = Date.now } = {}) {
  const d = join(dir, 'sessions')
  mkdirSync(d, { recursive: true })
  const file = (p) => join(d, `${p}.json`)
  let stopHeartbeat = null
  return {
    register(info) {
      writeJsonAtomic(file(pid), { pid, startedAt: new Date(now()).toISOString(), ...info })
      stopHeartbeat ??= startHeartbeat(file(pid))
    },
    unregister() {
      stopHeartbeat?.()
      try {
        unlinkSync(file(pid))
      } catch {}
    },
    // Live sessions, this one included. Dead ones are deleted; corrupt files are skipped, never trusted.
    list() {
      const out = []
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.json')) continue
        const path = join(d, f)
        let s
        try {
          s = JSON.parse(readFileSync(path, 'utf8'))
          s.mtimeMs = statSync(path).mtimeMs
        } catch {
          continue
        }
        if (s?.pid && isAlive(s.pid) && now() - s.mtimeMs < STALE_MS) out.push(s)
        else
          try {
            unlinkSync(path)
          } catch {}
      }
      return out
    },
  }
}
