// One send, end to end: validate -> resolve -> check -> duplicate guard -> human approval -> queue -> journal -> send.
// A follower session resolves locally, asks approval to take over and send in one dialog, takes over, then checks.
// Every return starts with one of: SENT | NOTHING SENT | NOT SENT | OUTCOME UNKNOWN.
import { randomUUID } from 'node:crypto'
import { buildPreview } from './approval.js'
import { describe, label, sanitize } from './contacts.js'
import { loadFile, MAX_FILE_BYTES } from './file.js'
import { describeGroup, findMe } from './groups.js'
import { hashText } from './journal.js'
import { log, maskJid } from './log.js'

export const MAX_CHARS = 4096

// Every message to someone else says Claude wrote it. One fixed line, so the dialog shows exactly what goes out
// and a resend of the same message is byte-identical.
export const SIGNATURE = '🤖 This message is written by Claude'
export const withSignature = (text) => (text ? `${text}\n\n${SIGNATURE}` : SIGNATURE)

// Header of messages to your own chat: which project's session is talking.
export const selfHeader = (sessionLabel) => (sessionLabel ? `🤖 walink · ${sessionLabel}` : '🤖 walink')

export function createSender({
  contacts,
  conn,
  getJournal, // () => journal | null (null while this process is a follower)
  approve, // async (preview) => { ok } | { ok: false, state, reason }
  role, // () => { owner: boolean, holder? }
  takeOver, // async () => { ok } | { ok: false, reason }: become the owner (followers only); absent = followers never send
  selfJid = () => null, // own chat ID while following (conn.me() needs a socket)
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minGapMs = 1500,
  perMinute = 15,
  newId = randomUUID,
  newMsgId,
  maxFileBytes = MAX_FILE_BYTES,
  sessionLabel = null, // this session's name in notifications (the folder Claude Code runs in), or null
  resolveTo = (to) => contacts.resolve(to), // -> { match } for a person | { group } for a group (lib/groups.js resolveTarget)
  groups = null, // group store, refreshed from the live lookup before each group send
  autoreply = null, // lib/autoreply.js: chats Claude may answer without a dialog
  random = Math.random,
}) {
  let chain = Promise.resolve()
  let queued = 0
  let lastSend = -Infinity
  const sentTimes = []
  const recent = new Map() // msgId -> message proto, in memory only, so Baileys can answer a recipient's retry request
  const sentIds = new Set() // every message id walink sent in this process, so its own messages are never read back as input

  // Your own chat, by phone-number JID or LID. While following there is no socket: use the linked-device creds.
  function isSelfJid(jid, follower) {
    const self = (!follower && conn.self?.()) || { pn: selfJid(), lid: null }
    return Boolean(jid) && (jid === self.pn || jid === self.lid)
  }

  function remember(msgId, message) {
    recent.set(msgId, message)
    if (recent.size > 200) recent.delete(recent.keys().next().value)
  }

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

  // Look like a person answering: a moment to notice, read it (blue ticks), then online and typing for about as long
  // as the text takes to type. Every step is best-effort.
  async function humanize(jid, text) {
    const between = (a, b) => a + random() * (b - a)
    await sleep(between(3000, 10_000))
    const key = autoreply.lastKey(jid)
    if (key) await conn.markRead([key])
    await conn.presence('available', jid)
    await conn.presence('composing', jid)
    await sleep(Math.min(12_000, Math.max(2000, [...text].length * 50)) * between(0.8, 1.2))
    await conn.presence('paused', jid)
  }

  // kind (internal): 'notify' | 'ask' for messages from the phone-channel tools, 'auto' for whatsapp_reply; absent for whatsapp_send.
  async function send({ to, text, file, resend_of: resendOf, kind } = {}) {
    const reqId = newId()
    let journal = getJournal()
    const result = (status, message, extra = {}) => {
      log(status === 'SENT' ? 'info' : 'warn', 'send_result', { reqId, status, ...extra })
      return { status, reqId, ...(extra.msgId && { msgId: extra.msgId }), text: `${status}: ${message}\n(request ${reqId})` }
    }
    const nothing = (reason, fields = {}) => {
      if (journal && fields.jid) journal.append({ reqId, state: 'rejected', reason, jid: fields.jid })
      return result('NOTHING SENT', reason)
    }

    // With a file, text is an optional caption; without one, it is the message.
    const caption = typeof text === 'string' && text.trim() ? text : null
    if (file == null && !caption) return nothing('the message is empty')
    if (text != null && typeof text !== 'string') return nothing('the caption must be text')
    if (caption && !caption.isWellFormed()) return nothing('the message contains invalid Unicode (lone surrogates)')
    if (caption && [...caption].length > MAX_CHARS) return nothing(`the message is ${[...caption].length} characters; the limit is ${MAX_CHARS}`)
    let doc = null
    if (file != null) {
      doc = loadFile(file, { maxBytes: maxFileBytes })
      if (doc.error) return nothing(doc.error)
    }

    const { owner, holder } = role()
    const follower = !owner || !journal
    if (follower && !takeOver) {
      return nothing(`WhatsApp is owned by another Claude Code session (pid ${holder?.pid ?? '?'}). Send from that session, or close it; this one takes over automatically.`)
    }

    let r
    const isMe = /^@?me$/i.test(String(to ?? '').trim())
    if (isMe) {
      const me = follower ? selfJid() : conn.me()
      if (!me) return nothing(follower ? 'your own chat ID is unknown: WhatsApp is not linked yet' : `your own chat ID is unknown until WhatsApp connects (${conn.whyUnusable()})`)
      r = { match: { jid: me, name: 'me (your own chat)', phone: me.split('@')[0] }, via: '"me"' }
    } else {
      r = resolveTo(to)
    }
    if (r.error) return nothing(r.error)
    if (!r.match && !r.group) {
      if (!r.candidates.length) return nothing(`no contact matches "${to}". Use a full name, an international phone number (+94…), or whatsapp_set_alias.`)
      const list = r.candidates.slice(0, 15).map((c) => `- ${describe(c)}`).join('\n')
      return nothing(`"${to}" matches ${r.candidates.length} contacts; not guessing. Ask the user which one:\n${list}`)
    }

    let contact = r.match ?? null
    let group = r.group ?? null
    let groupMeta = null // the live metadata shown in the dialog; the send goes to exactly these members
    const jid = group ? group.jid : contact.jid
    const who = () => (group ? describeGroup(group) : describe(contact))
    const textHash = doc ? hashText(`file:${doc.sha256}:${caption ?? ''}`) : hashText(text)
    // Never the file's path or contents: name, size and fingerprint only.
    const fileMeta = doc && { name: doc.name, size: doc.size, sha256: doc.sha256 }
    const record = { reqId, state: 'pending', jid, textHash, len: [...(caption ?? '')].length, via: r.via, ...(fileMeta && { file: fileMeta }), ...(group && { kind: 'group' }), ...(resendOf && { resendOf }) }
    const toSelf = !group && isSelfJid(jid, follower)
    // What actually goes out: to others, with the AI signature (a file with no caption gets it as its caption).
    const outText = toSelf ? caption : withSignature(caption)
    const but = toSelf ? '' : 'approved, but '

    const deliver = () =>
      enqueue(async () => {
        await pace()
        if (!role().owner) {
          journal.append({ reqId, state: 'rejected', reason: 'lost ownership of the WhatsApp session' })
          return result('NOTHING SENT', `${but}this session no longer owns the WhatsApp connection`)
        }
        if (!conn.usable()) {
          const why = conn.whyUnusable()
          journal.append({ reqId, state: 'rejected', reason: why })
          return result('NOTHING SENT', `${but}${why}. Try again when whatsapp_status shows connected.`)
        }
        const msgId = newMsgId()
        sentIds.add(msgId)
        // Durable BEFORE the socket sees anything. A document starts as 'uploading': until the upload finishes
        // nothing can have been sent, so a crash there is a certain failure, not an unknown outcome.
        journal.append({ reqId, state: doc ? 'uploading' : 'sending', msgId })
        if (!doc) remember(msgId, { conversation: outText })
        log('info', 'send_start', { reqId, msgId, jid: maskJid(jid), ...(doc && { fileSize: doc.size }), ...(kind && { kind }), ...(group && { group: true }) })

        const content = doc ? { document: doc.bytes, mimetype: doc.mimetype, fileName: doc.name, ...(outText && { caption: outText }) } : { text: outText }
        if (groupMeta) conn.groupCache.set(jid, groupMeta)
        let out
        try {
          out = await conn.sendContent(jid, content, msgId, (m) => remember(msgId, m), {
            onUploaded: doc ? () => journal.append({ reqId, state: 'sending' }) : undefined,
          })
        } finally {
          if (groupMeta) conn.groupCache.delete(jid)
        }
        lastSend = now()
        sentTimes.push(lastSend)
        journal.append({ reqId, state: out.outcome, ...(out.reason && { reason: out.reason }) })

        const subject = doc ? `file "${doc.name}" to ${who()}` : `to ${who()}`
        if (out.outcome === 'sent') {
          return result('SENT', `${subject}. The WhatsApp server accepted it (message id ${msgId}). Delivery and read receipts are not tracked.`, { msgId })
        }
        if (out.outcome === 'failed') return result('NOT SENT', `${subject}: ${out.reason}.${out.phase === 'upload' ? ' It is safe to try again.' : ''}`, { msgId })
        return result(
          'OUTCOME UNKNOWN',
          `for ${who()}: ${out.reason}. The message may or may not have reached WhatsApp (message id ${msgId}). Ask the user to check WhatsApp. Do not resend unless they explicitly ask; then call whatsapp_send with resend_of="${reqId}".`,
          { msgId },
        )
      })

    // Your own chat can only reach you: no approval dialog, and no duplicate guards (a repeat only reaches you).
    if (toSelf) {
      if (follower) {
        const t = await takeOver({ soft: true })
        if (!t.ok) return nothing(t.reason)
        journal = getJournal()
      }
      if (!conn.usable()) return nothing(conn.whyUnusable(), { jid })
      journal.append({ ...record, self: true, ...(kind && { kind }) })
      return deliver()
    }

    // Auto-replies: no dialog, but only as a reply in a chat the user enabled, within caps (lib/autoreply.js).
    if (kind === 'auto') {
      if (group || toSelf || doc || !autoreply) return nothing('auto-replies are text only, to a 1:1 chat enabled for auto-reply')
      if (follower) return nothing('this session does not hold WhatsApp, so it has no incoming message to reply to')
      const c = autoreply.check(jid, journal.records())
      if (c) {
        if (c.pausedNow) notify(`walink: auto-reply to ${who()} paused for an hour: ${c.error}.`)
        return nothing(c.error, { jid })
      }
      if (!conn.usable()) return nothing(conn.whyUnusable(), { jid })
      autoreply.replying(jid)
      journal.append({ ...record, kind: 'auto' })
      await humanize(jid, caption)
      const stopped = !autoreply.isOn() || !autoreply.get(jid) ? 'auto-reply was switched off' : autoreply.paused(jid)
      if (stopped) {
        journal.append({ reqId, state: 'rejected', reason: stopped })
        await conn.presence('unavailable')
        return result('NOTHING SENT', `${stopped} while the reply was being typed.`)
      }
      const out = await deliver()
      if (out.status === 'SENT') autoreply.sent(jid)
      conn.presence('unavailable')
      return out
    }

    // Duplicate guard: an earlier attempt of this exact content to this chat with an uncertain outcome blocks a blind resend.
    function guard() {
      const prior = journal.findUncertain(jid, textHash)
      if (prior && resendOf !== prior.reqId) {
        return {
          error: `an earlier attempt to send this exact message to ${who()} (request ${prior.reqId}, ${prior.ts}) ended as ${prior.state.toUpperCase()}: it may already have been delivered. Ask the user to check WhatsApp. Only if they explicitly want it sent again, call whatsapp_send with resend_of="${prior.reqId}".`,
        }
      }
      if (resendOf) {
        const old = journal.get(resendOf)
        if (!old || old.jid !== jid || old.textHash !== textHash) return { error: `resend_of="${resendOf}" is not an earlier attempt of this exact message to this recipient` }
      }
      return { prior }
    }

    // Groups: stricter than people. Enabled by the user, checked live, then a GROUP dialog (typed name above 50 members).
    if (group) {
      if (follower) {
        const t = await takeOver({ soft: true })
        if (!t.ok) return nothing(t.reason)
        journal = getJournal()
      }
      if (!group.enabled) {
        return nothing(`${who()} isn't enabled for sending. Ask the user; they can enable it with whatsapp_group_enable (a dialog only they can approve).`, { jid })
      }
      if (!conn.usable()) return nothing(conn.whyUnusable(), { jid })
      try {
        groupMeta = await conn.groupMetadata(jid)
      } catch (e) {
        return nothing(`can't reach ${who()} (${e.message}). You may have left it, or it may have been deleted.`, { jid })
      }
      const me = conn.self?.()
      if (groupMeta.participants?.length && !findMe(groupMeta.participants, me)) return nothing(`you are no longer a member of ${who()}.`, { jid })
      groups?.upsertMeta(groupMeta, me)
      const enabledSubject = group.enabledSubject
      group = { ...group, ...(groups?.get(jid) ?? {}) }
      if (group.isCommunity) return nothing(`${who()} is a community; post in its announcements group instead.`, { jid })
      if (group.announce && !group.amAdmin) return nothing(`only admins can post in ${who()}, and you are not an admin there.`, { jid })
      const g = guard()
      if (g.error) return nothing(g.error, { jid })

      const warnings = []
      const recentSent = journal.findRecentSent(jid, textHash)
      if (recentSent) warnings.push(`You already sent this exact message to this group ${Math.max(1, Math.round((now() - Date.parse(recentSent.ts)) / 60_000))} min ago.`)
      if (g.prior) warnings.push(`RESEND: an earlier attempt (${g.prior.ts}) may already have been delivered. Approve only if you checked WhatsApp.`)
      if (enabledSubject && enabledSubject !== group.subject) warnings.push(`Renamed since you enabled it: it was "${sanitize(enabledSubject, 100)}".`)
      if (group.size > 256) warnings.push('Large group: the outcome is reported only after WhatsApp confirms it.')
      warnings.push(...(doc?.warnings ?? []))
      if (caption && caption !== caption.trim()) warnings.push('The message starts or ends with spaces or blank lines.')

      journal.append(record)
      const confirmName = group.size > 50 ? sanitize(group.subject, 100) || null : null
      const preview = buildPreview({ group, via: r.via, text: outText, file: doc, warnings, connection: conn.status().state, confirmName })
      const approval = await approve(preview, { confirmName })
      if (!approval.ok) {
        journal.append({ reqId, state: approval.state === 'declined' ? 'declined' : 'expired', reason: approval.reason })
        return result('NOTHING SENT', `${approval.reason}.`)
      }
      if (g.prior) journal.append({ reqId: g.prior.reqId, resolvedBy: reqId })
      return deliver()
    }

    // Checks that need the socket and the journal. A follower runs them only after taking over.
    async function check() {
      if (!conn.usable()) return { error: conn.whyUnusable() }
      const exists = await conn.checkExists(jid, { known: isMe || Boolean(contacts.get(jid)) })
      if (!exists.ok) return { error: `${describe(contact)}: ${exists.reason}` }
      if (!contact.phone && exists.phone) contact = { ...contact, phone: exists.phone }
      return guard()
    }

    let prior = null
    if (!follower) {
      const c = await check()
      if (c.error) return nothing(c.error, { jid })
      prior = c.prior
    }

    const warnings = [...(doc?.warnings ?? [])]
    if (prior) warnings.push(`RESEND: an earlier attempt (${prior.ts}) may already have been delivered. Approve only if you checked WhatsApp.`)
    const recentSent = journal?.findRecentSent(jid, textHash)
    if (recentSent) warnings.push(`You already sent this exact message to them ${Math.max(1, Math.round((now() - Date.parse(recentSent.ts)) / 60_000))} min ago.`)
    if (r.also?.length) warnings.push(`The name also partly matches: ${r.also.slice(0, 5).map((c) => `"${label(c)}"`).join(', ')}`)
    if (!isMe && !contacts.get(jid)) warnings.push('This number is not in your synced WhatsApp contacts.')
    if (!contact.phone) warnings.push('No phone number is known for this contact; check the name carefully.')
    if (caption && caption !== caption.trim()) warnings.push('The message starts or ends with spaces or blank lines.')

    if (!follower) journal.append(record)
    const takeover = follower ? (holder?.pid ?? '?') : null
    const approval = await approve(buildPreview({ contact, via: r.via, text: outText, file: doc, warnings, connection: conn.status().state, takeover }))
    if (!approval.ok) {
      journal?.append({ reqId, state: approval.state === 'declined' ? 'declined' : 'expired', reason: approval.reason })
      return result('NOTHING SENT', `${approval.reason}.`)
    }

    if (follower) {
      const t = await takeOver()
      if (!t.ok) return result('NOTHING SENT', `approved, but ${t.reason}.`)
      journal = getJournal()
      const c = await check()
      if (c.error) return nothing(`approved and took over WhatsApp, but ${c.error}`, { jid })
      prior = c.prior
      journal.append(record)
    }
    if (prior) journal.append({ reqId: prior.reqId, resolvedBy: reqId })

    return deliver()
  }

  // A notification to your own chat, headed with this session's name. No dialog.
  const notify = (text) => send({ to: 'me', text: `${selfHeader(sessionLabel)}\n${text}`, kind: 'notify' })

  return {
    send,
    notify,
    isOwnMessage: (id) => sentIds.has(id) || Boolean(getJournal()?.hasMsgId(id)),
    getMessage: (id) => recent.get(id), // message proto for Baileys to re-encrypt on a recipient's retry request
    queueDepth: () => queued,
    idle: () => chain, // settles once every queued send has finished (used before handing the session over)
  }
}
