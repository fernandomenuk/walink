// Auto-reply for 1:1 chats the user enabled (by dialog). Claude may only REPLY: to an enabled chat, soon after that
// person wrote, a few times per message, within hourly and daily caps. It can never start a conversation.
// autoreply.json holds what must survive a restart or a handover (enabled chats, pauses, the global switch); it is
// re-read on every call so `node server.js autoreply off` applies at once. Reply counts come from the send journal.
import { join } from 'node:path'
import { loadJson, writeJsonAtomic } from './persist.js'

export const LIMITS = {
  replyWindowMs: 15 * 60_000, // a reply must follow their message within this
  perBurst: 3, // replies per incoming message (or burst of messages)
  perChatHour: 20,
  perDay: 60, // all chats together
  humanPauseMs: 30 * 60_000, // after you type in the chat yourself
  botPauseMs: 60 * 60_000, // after the other side looks like a bot
  fastReplyMs: 2_000, // "instant" answers to our replies, three in a row = probably a bot
}
const OUT = new Set(['sending', 'sent', 'unknown']) // attempts that may have reached WhatsApp count toward the caps

const valid = (v) => v && typeof v === 'object' && typeof v.on === 'boolean' && v.chats && typeof v.chats === 'object'

export function createAutoReply(dir, { now = Date.now } = {}) {
  const file = join(dir, 'autoreply.json')
  const load = () => loadJson(file, valid, { on: true, chats: {} })
  const save = (s) => writeJsonAtomic(file, s)
  const threads = new Map() // jid -> { lastIn, lastKey, replies, lastOut, fast }: this process only

  const pausedFor = (c) => (c?.pausedUntil && c.pausedUntil > now() ? c.pauseReason : null)

  function pause(jid, ms, reason) {
    const s = load()
    if (!s.chats[jid]) return
    s.chats[jid] = { ...s.chats[jid], pausedUntil: now() + ms, pauseReason: reason }
    save(s)
  }

  return {
    // Canonical enabled jid among the forms WhatsApp gave (phone-number JID and/or LID), or null.
    match(jids) {
      const s = load()
      return (s.on && jids.find((j) => j && s.chats[j])) || null
    },
    get: (jid) => load().chats[jid] ?? null,
    list: () => Object.entries(load().chats).map(([jid, c]) => ({ jid, ...c, paused: pausedFor(c) })),
    isOn: () => load().on,
    setOn(on) {
      const s = load()
      s.on = on
      save(s)
      return s
    },
    enable(jid, name) {
      const s = load()
      s.chats[jid] = { name, enabledAt: new Date(now()).toISOString() }
      save(s)
    },
    disable(jid) {
      const s = load()
      const had = Boolean(s.chats[jid])
      delete s.chats[jid]
      save(s)
      threads.delete(jid)
      return had
    },
    pause,
    paused: (jid) => pausedFor(load().chats[jid]),

    // Their message arrived. Returns a pause reason when this message tripped the bot guard, else null.
    incoming(jid, key, ts = now()) {
      const t = threads.get(jid) ?? { fast: 0 }
      t.fast = t.lastOut != null && ts - t.lastOut < LIMITS.fastReplyMs ? t.fast + 1 : 0
      Object.assign(t, { lastIn: ts, lastKey: key, replies: 0 })
      threads.set(jid, t)
      if (t.fast < 3) return null
      const why = 'their replies arrive within 2 seconds, like another bot'
      pause(jid, LIMITS.botPauseMs, why)
      return why
    },
    lastKey: (jid) => threads.get(jid)?.lastKey ?? null,

    // null when a reply may go out now, else { error, pausedNow? }. records: the send journal.
    check(jid, records) {
      const e = why(jid, records)
      return e && (typeof e === 'string' ? { error: e } : e)
    },
    // Before the typing pause: counts toward the per-message cap, so parallel calls can't pass it.
    replying(jid) {
      const t = threads.get(jid)
      if (t) t.replies++
    },
    // After WhatsApp accepted it: the bot guard times their next answer from here.
    sent(jid) {
      const t = threads.get(jid)
      if (t) t.lastOut = now()
    },
  }

  function why(jid, records) {
    const s = load()
    const c = s.chats[jid]
    if (!s.on) return 'auto-reply is switched off (the user can turn it on with /walink:autoreply on)'
    if (!c) return 'this chat is not enabled for auto-reply. Only the user can enable it (whatsapp_autoreply_enable shows them a dialog); use whatsapp_send instead'
    const p = pausedFor(c)
    if (p) return `auto-reply to this chat is paused until ${new Date(c.pausedUntil).toISOString()}: ${p}`
    const t = threads.get(jid)
    if (!t?.lastIn || now() - t.lastIn > LIMITS.replyWindowMs) return 'auto-reply only answers a message they sent in the last 15 minutes; nothing to reply to'
    if (t.replies >= LIMITS.perBurst) return `already replied ${LIMITS.perBurst} times to their last message; wait for them to write again`
    const out = records.filter((r) => r.kind === 'auto' && OUT.has(r.state))
    const since = (ms) => out.filter((r) => now() - Date.parse(r.ts) < ms)
    if (since(3600_000).filter((r) => r.jid === jid).length >= LIMITS.perChatHour) {
      pause(jid, 3600_000, `hourly cap of ${LIMITS.perChatHour} replies reached`)
      return { error: `hourly cap of ${LIMITS.perChatHour} auto-replies to this chat reached; paused for an hour`, pausedNow: true }
    }
    if (since(86_400_000).length >= LIMITS.perDay) return `daily cap of ${LIMITS.perDay} auto-replies reached`
    return null
  }
}
