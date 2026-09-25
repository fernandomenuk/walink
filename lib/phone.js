// Phone channel: the user's own WhatsApp chat as a two-way line to this Claude Code session.
//   out: questions (whatsapp_ask_me) and notices, sent to your own chat without a dialog
//   in:  replies to questions, and "@claude ..." messages, pushed into the session as channel notifications
// Only YOUR messages count: your own chat, fromMe, not sent by walink, not forwarded (someone else wrote those),
// and new (backlog is never replayed as a command). The journal records questions, never message text.
import { normalizeMessageContent } from '@whiskeysockets/baileys'
import { isAlive } from './lock.js'
import { log } from './log.js'
import { selfHeader } from './sender.js'

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 2 * 60 * 1000 // the phone's clock and this PC's may disagree
const PREFIX = /^\s*@claude\b[\s:,]*/i
const OPEN_STATES = new Set(['open'])

export function createPhone({
  conn, // self(), sendRaw(jid, content)
  sender, // send({ to: 'me', text, kind }), notify(text), isOwnMessage(id)
  getJournal, // () => journal | null (null while following)
  pushChannel = () => {}, // ({ content, meta }) => void: notifications/claude/channel
  sessionLabel = null,
  pid = process.pid,
  ownerSince = () => 0, // ms when this process became the owner
  now = Date.now,
}) {
  const seen = new Set() // message ids already handled (Baileys can deliver one twice)
  const waiters = new Map() // qid -> (answer) => void, for whatsapp_ask_me calls waiting right now
  const mem = new Map() // qid -> { question, options, sentAt, answer? }: text lives in memory only

  const questions = () => (getJournal()?.records() ?? []).filter((r) => r.type === 'question')
  const selfJids = () => {
    const s = conn.self?.()
    return new Set([s?.pn, s?.lid].filter(Boolean))
  }
  const bare = (jid) => String(jid ?? '').replace(/:\d+@/, '@')

  function expire() {
    const journal = getJournal()
    for (const q of questions()) {
      if (OPEN_STATES.has(q.state) && Date.parse(q.expiresAt) <= now()) journal.append({ reqId: q.reqId, state: 'expired' })
    }
  }

  // Open questions asked by this process, newest first.
  const mine = () => questions().filter((q) => q.state === 'open' && q.owner?.pid === pid).sort((a, b) => b.sentAt - a.sentAt)

  function react(key, emoji) {
    conn.sendRaw?.(key.remoteJid, { react: { text: emoji, key } })?.catch((e) => log('warn', 'react_failed', { err: e.message }))
  }

  function nextQid() {
    const n = questions().reduce((max, q) => Math.max(max, Number(q.reqId.slice(1)) || 0), 0)
    return `Q${n + 1}`
  }

  function formatQuestion(question, options, others) {
    const lines = [`${selfHeader(sessionLabel)} asks:`, question]
    if (options.length) lines.push('', ...options.map((o, i) => `${i + 1}) ${o}`), 'Reply with a number or your own words.')
    if (others) lines.push('', 'Several questions are open: swipe-reply to this one to answer it.')
    return lines.join('\n')
  }

  // Reply text -> what the model reads. A bare number picks that option.
  function interpret(q, text) {
    const opts = mem.get(q.reqId)?.options ?? []
    const n = /^\s*(\d{1,2})\s*$/.exec(text)?.[1]
    if (n && Number(n) >= 1 && Number(n) <= opts.length) return `${opts[n - 1]} (option ${n})`
    return text
  }

  function deliver(q, text, key) {
    const answer = interpret(q, text)
    getJournal().append({ reqId: q.reqId, state: 'answered', replyMsgId: key.id, replyLen: [...text].length })
    react(key, '✅')
    const m = mem.get(q.reqId)
    if (m) m.answer = answer
    const waiter = waiters.get(q.reqId)
    if (waiter) return waiter.answer(answer)
    const about = m ? `Reply to "${m.question.slice(0, 80)}${m.question.length > 80 ? '…' : ''}"` : `Reply to question ${q.reqId}`
    pushChannel({ content: `${about}: ${answer}`, meta: { kind: 'answer', question_id: q.reqId } })
  }

  function handle(msg, type) {
    const key = msg?.key
    if (!key?.fromMe || !key.id || type !== 'notify') return
    const self = selfJids()
    if (!self.has(bare(key.remoteJid))) return
    if (seen.has(key.id)) return
    seen.add(key.id)
    if (seen.size > 1000) seen.delete(seen.values().next().value)
    if (sender.isOwnMessage(key.id)) return // walink's own notifications, questions and notices

    const content = normalizeMessageContent(msg.message)
    if (!content || content.reactionMessage || content.protocolMessage || content.editedMessage) return // reactions, edits, deletes
    const ctx = content.extendedTextMessage?.contextInfo
    if (ctx?.isForwarded) return react(key, '⚠️') // written by someone else: never input
    const text = content.conversation ?? content.extendedTextMessage?.text
    const ts = Number(msg.messageTimestamp) * 1000 || now()
    if (!getJournal()) return
    expire()

    const open = mine()
    if (typeof text !== 'string' || !text.trim()) {
      if (open.length) sender.notify('walink: only text replies are supported for now.')
      return
    }

    // 1. A swipe-reply to a question names it exactly.
    const quoted = ctx?.stanzaId && questions().find((q) => q.msgId === ctx.stanzaId)
    if (quoted) {
      if (quoted.state !== 'open') return void sender.notify('⌛ That question is already closed; this reply was not delivered.')
      const ownerAlive = quoted.owner?.pid === pid || !isAlive(quoted.owner?.pid)
      if (!ownerAlive) {
        return void sender.notify(`↪ That question belongs to the ${quoted.owner?.label ?? 'other'} session, which no longer holds WhatsApp. Answer it at the computer.`)
      }
      if (ts < quoted.sentAt - CLOCK_SKEW_MS) return
      return deliver(quoted, text, key)
    }
    // 2./3. Otherwise the newest open question of this session.
    if (open.length && ts >= open[0].sentAt - CLOCK_SKEW_MS) return deliver(open[0], text, key)
    // 4. No question: only "@claude ..." reaches the session; anything else is a private note.
    if (!PREFIX.test(text) || ts < ownerSince() - CLOCK_SKEW_MS) return
    const body = text.replace(PREFIX, '').trim()
    if (!body) return
    react(key, '👀')
    pushChannel({ content: body, meta: { kind: 'message' } })
  }

  function onMessages({ messages = [], type } = {}) {
    for (const m of messages) {
      try {
        handle(m, type)
      } catch (e) {
        log('error', 'phone_message_failed', { err: e.message })
      }
    }
  }

  // whatsapp_ask_me. Returns { status, text }; status: REPLY | NO REPLY YET | CANCELLED | NOT SENT | NOTHING SENT | OUTCOME UNKNOWN.
  async function ask({ question, options = [], waitMs = 10 * 60_000, waitFor, signal, onProgress }) {
    let qid = waitFor
    if (waitFor) {
      const q = getJournal() && questions().find((r) => r.reqId === waitFor)
      if (!q) return { status: 'NOTHING SENT', text: `NOTHING SENT: there is no question ${waitFor}${getJournal() ? '' : ' in this session'}.` }
      const answer = mem.get(waitFor)?.answer
      if (q.state === 'answered') {
        return answer !== undefined
          ? { status: 'REPLY', text: `REPLY (question ${waitFor}): ${answer}` }
          : { status: 'NOTHING SENT', text: `NOTHING SENT: question ${waitFor} was already answered (the reply was delivered as a walink channel message).` }
      }
      if (q.state !== 'open') return { status: 'NOTHING SENT', text: `NOTHING SENT: question ${waitFor} is ${q.state}. Ask again if it still matters.` }
      if (q.owner?.pid !== pid) return { status: 'NOTHING SENT', text: `NOTHING SENT: question ${waitFor} belongs to another session.` }
    } else {
      const r = await sender.send({ to: 'me', text: formatQuestion(question, options, mine().length > 0), kind: 'ask' })
      if (r.status !== 'SENT') return r
      const journal = getJournal()
      qid = nextQid()
      const sentAt = now()
      journal.append({ reqId: qid, type: 'question', state: 'open', msgId: r.msgId, sentAt, owner: { pid, label: sessionLabel }, optionsCount: options.length, expiresAt: new Date(sentAt + QUESTION_TTL_MS).toISOString() })
      mem.set(qid, { question, options, sentAt, msgId: r.msgId })
    }

    return new Promise((resolve) => {
      let progress = 0
      const finish = (res) => {
        clearTimeout(timer)
        clearInterval(ticker)
        signal?.removeEventListener('abort', onAbort)
        waiters.delete(qid)
        resolve(res)
      }
      const onAbort = () => {
        getJournal()?.append({ reqId: qid, state: 'cancelled' })
        const m = mem.get(qid)
        const self = conn.self?.()
        if (m && self) conn.sendRaw?.(self.pn, { text: `${formatQuestion(m.question, m.options, false)}\n\n(answered at the computer)`, edit: { remoteJid: self.pn, fromMe: true, id: m.msgId } })?.catch(() => {})
        finish({ status: 'CANCELLED', text: `CANCELLED: stopped waiting for question ${qid}; it is closed on WhatsApp too.` })
      }
      const timer = setTimeout(() => {
        const q = questions().find((r) => r.reqId === qid)
        finish({
          status: 'NO REPLY YET',
          text: `NO REPLY YET: question ${qid} is still open (expires ${q?.expiresAt ?? 'in 24h'}). The answer will arrive as a walink channel message, or call whatsapp_ask_me with wait_for="${qid}".`,
        })
      }, waitMs)
      const ticker = setInterval(() => onProgress?.(++progress), 30_000)
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort)
      waiters.set(qid, {
        answer: (answer) => finish({ status: 'REPLY', text: `REPLY (question ${qid}): ${answer}` }),
        end: (why) => finish({ status: 'NO REPLY YET', text: `NO REPLY YET: stopped waiting for question ${qid} because ${why}. Ask again if it still matters.` }),
      })
    })
  }

  // WhatsApp moved to another session: end every wait here with a clear result.
  function endWaits(why) {
    for (const w of [...waiters.values()]) w.end(why)
  }

  return {
    onMessages,
    ask,
    waiting: () => waiters.size > 0,
    openQuestions: () => (getJournal() ? (expire(), mine()) : []),
    endWaits,
  }
}
