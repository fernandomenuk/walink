// One send, end to end: validate -> resolve -> check -> duplicate guard -> human approval -> queue -> journal -> send.
// Every return starts with one of: SENT | NOTHING SENT | NOT SENT | OUTCOME UNKNOWN.
import { randomUUID } from 'node:crypto'
import { buildPreview } from './approval.js'
import { describe, label } from './contacts.js'
import { hashText } from './journal.js'
import { log, maskJid } from './log.js'

export const MAX_CHARS = 4096

export function createSender({
  contacts,
  conn,
  getJournal, // () => journal | null (null while this process is a follower)
  approve, // async (preview) => { ok } | { ok: false, state, reason }
  role, // () => { owner: boolean, holder? }
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minGapMs = 1500,
  perMinute = 15,
  newId = randomUUID,
  newMsgId,
}) {
  let chain = Promise.resolve()
  let queued = 0
  let lastSend = -Infinity
  const sentTimes = []
  const recent = new Map() // msgId -> text, in memory only, so Baileys can answer a recipient's retry request

  function enqueue(fn) {
    queued++
    const p = chain.then(fn).finally(() => queued--)
    chain = p.catch(() => {})
    return p
  }

  async function pace() {
    for (;;) {
      const t = now()
      while (sentTimes.length && t - sentTimes[0] >= 60_000) sentTimes.shift()
      const wait = Math.max(lastSend + minGapMs - t, sentTimes.length >= perMinute ? sentTimes[0] + 60_000 - t : 0)
      if (wait <= 0) return
      await sleep(wait)
    }
  }

  async function send({ to, text, resend_of: resendOf } = {}) {
    const reqId = newId()
    const journal = getJournal()
    const result = (status, message, extra = {}) => {
      log(status === 'SENT' ? 'info' : 'warn', 'send_result', { reqId, status, ...extra })
      return { status, reqId, text: `${status}: ${message}\n(request ${reqId})` }
    }
    const nothing = (reason, fields = {}) => {
      if (journal && fields.jid) journal.append({ reqId, state: 'rejected', reason, jid: fields.jid })
      return result('NOTHING SENT', reason)
    }

    if (typeof text !== 'string' || !text.trim()) return nothing('the message is empty')
    if (!text.isWellFormed()) return nothing('the message contains invalid Unicode (lone surrogates)')
    if ([...text].length > MAX_CHARS) return nothing(`the message is ${[...text].length} characters; the limit is ${MAX_CHARS}`)

    const { owner, holder } = role()
    if (!owner || !journal) {
      return nothing(`WhatsApp is owned by another Claude Code session (pid ${holder?.pid ?? '?'}). Send from that session, or close it; this one takes over automatically.`)
    }

    let r
    const isMe = /^@?me$/i.test(String(to ?? '').trim())
    if (isMe) {
      const me = conn.me()
      if (!me) return nothing(`your own chat ID is unknown until WhatsApp connects (${conn.whyUnusable()})`)
      r = { match: { jid: me, name: 'me (your own chat)', phone: me.split('@')[0] }, via: '"me"' }
    } else {
      r = contacts.resolve(to)
    }
    if (r.error) return nothing(r.error)
    if (!r.match) {
      if (!r.candidates.length) return nothing(`no contact matches "${to}". Use a full name, an international phone number (+94…), or whatsapp_set_alias.`)
      const list = r.candidates.slice(0, 15).map((c) => `- ${describe(c)}`).join('\n')
      return nothing(`"${to}" matches ${r.candidates.length} contacts; not guessing. Ask the user which one:\n${list}`)
    }

    let contact = r.match
    const { jid } = contact
    if (!conn.usable()) return nothing(conn.whyUnusable(), { jid })
    const exists = await conn.checkExists(jid, { known: isMe || Boolean(contacts.get(jid)) })
    if (!exists.ok) return nothing(`${describe(contact)}: ${exists.reason}`, { jid })
    if (!contact.phone && exists.phone) contact = { ...contact, phone: exists.phone }

    const textHash = hashText(text)
    const prior = journal.findUncertain(jid, textHash)
    if (prior && resendOf !== prior.reqId) {
      return nothing(
        `an earlier attempt to send this exact message to ${describe(contact)} (request ${prior.reqId}, ${prior.ts}) ended as ${prior.state.toUpperCase()}: it may already have been delivered. Ask the user to check WhatsApp. Only if they explicitly want it sent again, call whatsapp_send with resend_of="${prior.reqId}".`,
        { jid },
      )
    }
    if (resendOf) {
      const old = journal.get(resendOf)
      if (!old || old.jid !== jid || old.textHash !== textHash) {
        return nothing(`resend_of="${resendOf}" is not an earlier attempt of this exact message to this recipient`, { jid })
      }
    }

    const warnings = []
    if (prior) warnings.push(`RESEND: an earlier attempt (${prior.ts}) may already have been delivered. Approve only if you checked WhatsApp.`)
    const recentSent = journal.findRecentSent(jid, textHash)
    if (recentSent) warnings.push(`You already sent this exact message to them ${Math.max(1, Math.round((now() - Date.parse(recentSent.ts)) / 60_000))} min ago.`)
    if (r.also?.length) warnings.push(`The name also partly matches: ${r.also.slice(0, 5).map((c) => `"${label(c)}"`).join(', ')}`)
    if (!isMe && !contacts.get(jid)) warnings.push('This number is not in your synced WhatsApp contacts.')
    if (!contact.phone) warnings.push('No phone number is known for this contact; check the name carefully.')
    if (text !== text.trim()) warnings.push('The message starts or ends with spaces or blank lines.')

    journal.append({ reqId, state: 'pending', jid, textHash, len: [...text].length, via: r.via, ...(resendOf && { resendOf }) })
    const approval = await approve(buildPreview({ contact, via: r.via, text, warnings, connection: conn.status().state }))
    if (!approval.ok) {
      journal.append({ reqId, state: approval.state === 'declined' ? 'declined' : 'expired', reason: approval.reason })
      return result('NOTHING SENT', `${approval.reason}.`)
    }
    if (prior) journal.append({ reqId: prior.reqId, resolvedBy: reqId })

    return enqueue(async () => {
      await pace()
      if (!role().owner) {
        journal.append({ reqId, state: 'rejected', reason: 'lost ownership of the WhatsApp session' })
        return result('NOTHING SENT', 'approved, but this session no longer owns the WhatsApp connection')
      }
      if (!conn.usable()) {
        const why = conn.whyUnusable()
        journal.append({ reqId, state: 'rejected', reason: why })
        return result('NOTHING SENT', `approved, but ${why}. Try again when whatsapp_status shows connected.`)
      }
      const msgId = newMsgId()
      journal.append({ reqId, state: 'sending', msgId }) // durable BEFORE the socket sees anything
      recent.set(msgId, text)
      if (recent.size > 200) recent.delete(recent.keys().next().value)
      log('info', 'send_start', { reqId, msgId, jid: maskJid(jid) })

      const out = await conn.sendText(jid, text, msgId)
      lastSend = now()
      sentTimes.push(lastSend)
      journal.append({ reqId, state: out.outcome, ...(out.reason && { reason: out.reason }) })

      const who = describe(contact)
      if (out.outcome === 'sent') {
        return result('SENT', `to ${who}. The WhatsApp server accepted it (message id ${msgId}). Delivery and read receipts are not tracked.`, { msgId })
      }
      if (out.outcome === 'failed') return result('NOT SENT', `to ${who}: ${out.reason}.`, { msgId })
      return result(
        'OUTCOME UNKNOWN',
        `for ${who}: ${out.reason}. The message may or may not have reached WhatsApp (message id ${msgId}). Ask the user to check WhatsApp. Do not resend unless they explicitly ask; then call whatsapp_send with resend_of="${reqId}".`,
        { msgId },
      )
    })
  }

  return {
    send,
    getMessage: (id) => recent.get(id),
    queueDepth: () => queued,
  }
}
