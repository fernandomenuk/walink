// Pings to your own chat from Claude Code hooks (hooks/hooks.json -> the whatsapp_hook tool). One server per session,
// so this state is per session:
//   start   (UserPromptSubmit) -> remember when the turn began
//   stop    (Stop)             -> ping if the turn ran >= minMinutes and Claude didn't already notify you this turn
//   waiting (Notification: permission_prompt | elicitation_dialog) -> ping if still unanswered after delayMs
// "Unanswered" means the transcript hasn't grown: answering a prompt appends to it. Worst case a missed ping, never a false one.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log.js'
import { loadJson, writeJsonAtomic } from './persist.js'

export const NOTIFY_DEFAULTS = { on: true, minMinutes: 3 }

const settingsFile = (dir) => join(dir, 'notify.json')
const valid = (v) => v && typeof v === 'object' && typeof v.on === 'boolean' && Number.isFinite(v.minMinutes)
export const loadNotifySettings = (dir) => ({ ...NOTIFY_DEFAULTS, ...loadJson(settingsFile(dir), valid, {}) })

// arg: "on" | "off" | minutes (a number). Returns the saved settings, or null for an unknown arg.
export function updateNotifySettings(dir, arg) {
  const s = loadNotifySettings(dir)
  const a = String(arg ?? '').trim().toLowerCase()
  if (a === 'on' || a === 'off') s.on = a === 'on'
  else if (/^\d+(\.\d+)?$/.test(a)) Object.assign(s, { on: true, minMinutes: Number(a) })
  else if (a) return null
  else return s
  writeJsonAtomic(settingsFile(dir), s)
  return s
}

export const describeNotifySettings = (s) =>
  s.on
    ? `WhatsApp pings are ON: a task that runs ${s.minMinutes}+ min, and a permission or approval prompt left waiting for 1 min.`
    : 'WhatsApp pings are OFF.'

const fileSizeOf = (f) => {
  try {
    return statSync(f).size
  } catch {
    return null
  }
}

export function createHookHandler({ notify, settings, now = Date.now, delayMs = 60_000, fileSize = fileSizeOf }) {
  let turnStartedAt = null
  let notifiedThisTurn = false
  let pending = null
  const cancel = () => void (clearTimeout(pending), (pending = null))

  const ping = (text, why) =>
    Promise.resolve()
      .then(() => notify(text))
      .then((r) => log(r?.status === 'SENT' ? 'info' : 'warn', 'hook_ping', { why, result: String(r?.text ?? '').slice(0, 120) }))
      .catch((e) => log('warn', 'hook_ping_failed', { why, err: e.message }))

  function stop(message) {
    cancel()
    const started = turnStartedAt
    turnStartedAt = null
    const s = settings()
    if (!s.on || started == null || notifiedThisTurn) return
    const mins = (now() - started) / 60_000
    if (mins < s.minMinutes) return
    const reply = String(message ?? '').trim()
    const summary = reply.length > 300 ? `${reply.slice(0, 300)}…` : reply
    ping(`✅ Done after ${Math.round(mins)} min${summary ? `\n${summary}` : ''}`, 'stop')
  }

  function waiting(kind, message, transcript) {
    cancel()
    if (!settings().on) return
    const size = fileSize(transcript)
    pending = setTimeout(() => {
      pending = null
      if (!settings().on || size == null || fileSize(transcript) !== size) return
      const text = kind === 'elicitation_dialog' ? '⏸ A send is waiting for your approval' : `⏸ Waiting for you: ${String(message ?? '').trim() || 'permission needed'}`
      ping(text, kind)
    }, delayMs)
    pending.unref?.()
  }

  return {
    // Never throws: a hook error would show on every turn.
    handle({ event, kind, message, transcript } = {}) {
      try {
        if (event === 'start') {
          cancel()
          turnStartedAt = now()
          notifiedThisTurn = false
        } else if (event === 'stop') stop(message)
        else if (event === 'waiting') waiting(kind, message, transcript)
      } catch (e) {
        log('warn', 'hook_failed', { event, err: e.message })
      }
    },
    markNotified: () => void (notifiedThisTurn = true),
  }
}
