// Baileys session: single-flight connect, backoff with jitter, terminal vs transient close codes,
// server-ack tracking per message id, and recipient existence checks.
import { log, maskJid } from './log.js'

export const NOT_LINKED = 'WhatsApp is not linked yet. Run /walink:login in Claude Code.'

// Close codes after which reconnecting would be wrong or harmful.
export const TERMINAL = {
  401: ['logged_out', 'WhatsApp logged this device out. Run /walink:login in Claude Code.'],
  403: ['forbidden', 'WhatsApp refused the connection (403: account banned or restricted). Not retrying.'],
  500: ['bad_session', 'The saved session is corrupt (500). Run /walink:login in Claude Code to link again.'],
  440: ['conflict', 'Another client replaced this session (440). Not fighting back; close the other client, then restart.'],
}

export const backoffMs = (attempt, rand = Math.random) => Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.8 + 0.4 * rand()))

function withTimeout(p, ms, what) {
  let timer
  const t = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)))
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

export function createConnection({
  authDir,
  loadAuth, // async (dir) => { state, saveCreds }
  makeSocket, // async (authState) => Baileys socket
  onContacts = () => {},
  onMessages, // ({ messages, type }) from the current socket only
  onGroups, // ({ type: 'update' | 'upsert', items } | { type: 'participants', event }) from the current socket only
  prepareMessage, // async (sock, jid, content, msgId) => WAMessage: builds and uploads media (split from the relay)
  uploadTimeoutMs = 5 * 60_000,
  onQr,
  onOpen,
  onTerminal,
  login = false,
  now = Date.now,
  ackTimeoutMs = 20_000,
  staleMs = 45_000,
  checkTimeoutMs = 10_000,
  rand = Math.random,
}) {
  let sock = null
  let state = 'idle'
  let detail = ''
  let attempt = 0
  let inflight = null
  let retryTimer = null
  let lastFrame = 0
  let stopped = false
  const waiters = new Map() // msgId -> done(outcome)

  function set(s, d = '') {
    if (s !== state || d !== detail) log(s === 'connected' ? 'info' : 'warn', 'connection_state', { state: s, detail: d })
    state = s
    detail = d
  }

  function failWaiters(reason) {
    for (const done of [...waiters.values()]) done({ outcome: 'unknown', reason })
  }

  function schedule(ms) {
    if (retryTimer || stopped) return
    set('reconnecting', `retry in ${Math.round(ms / 1000)}s (attempt ${attempt})`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect().catch((e) => {
        log('error', 'connect_failed', { err: e.message })
        schedule(backoffMs(attempt++, rand))
      })
    }, ms)
  }

  function teardown() {
    const old = sock
    sock = null // handlers of `old` become no-ops via their `s === sock` guard
    if (old) {
      failWaiters('connection replaced while waiting for the server ack')
      try {
        old.end(undefined)
      } catch {}
    }
  }

  async function open() {
    clearTimeout(retryTimer)
    retryTimer = null
    teardown()
    const { state: auth, saveCreds } = await loadAuth(authDir)
    if (!login && !auth.creds?.me) return set('not_linked', NOT_LINKED)
    if (state !== 'reconnecting') set('connecting')
    const s = await makeSocket(auth)
    if (stopped) return void s.end?.(undefined)
    sock = s
    const mine = () => s === sock

    s.ev.on('creds.update', (...a) => {
      Promise.resolve(saveCreds(...a)).catch((e) => log('error', 'creds_save_failed', { err: e.message }))
    })
    const contacts = (list) => mine() && onContacts(list)
    s.ev.on('messaging-history.set', ({ contacts: list }) => contacts(list))
    s.ev.on('contacts.upsert', contacts)
    s.ev.on('contacts.update', contacts)
    s.ws.on('frame', () => mine() && (lastFrame = now()))
    s.ev.on('messages.upsert', (u) => mine() && onMessages?.(u))
    s.ev.on('groups.update', (items) => mine() && onGroups?.({ type: 'update', items }))
    s.ev.on('groups.upsert', (items) => mine() && onGroups?.({ type: 'upsert', items }))
    s.ev.on('group-participants.update', (event) => mine() && onGroups?.({ type: 'participants', event }))
    // The WhatsApp server acks every outgoing message stanza; an `error` attr means it was rejected.
    s.ws.on('CB:ack,class:message', (node) => {
      const done = waiters.get(node?.attrs?.id)
      if (!done) return
      if (node.attrs.error) done({ outcome: 'failed', reason: `WhatsApp rejected it (error ${node.attrs.error})` })
      else done({ outcome: 'sent' })
    })
    s.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (!mine()) return
      if (qr && onQr) onQr(qr)
      if (connection === 'open') {
        attempt = 0
        lastFrame = now()
        set('connected', `as ${maskJid(s.user?.id)}`)
        onOpen?.()
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        sock = null
        failWaiters(`connection closed (code ${code}) before the server ack`)
        if (TERMINAL[code]) {
          set(...TERMINAL[code])
          return onTerminal?.(code)
        }
        if (code === 515) return schedule(0) // restart required, e.g. right after QR pairing
        schedule(backoffMs(attempt++, rand))
      }
    })
  }

  function connect() {
    stopped = false
    inflight ??= open().finally(() => (inflight = null))
    return inflight
  }

  const usable = () => state === 'connected' && sock && now() - lastFrame < staleMs

  function whyUnusable() {
    if (state === 'connected' && sock) return `connection looks stale (no data from WhatsApp for ${Math.round((now() - lastFrame) / 1000)}s)`
    return `WhatsApp is ${state}${detail ? `: ${detail}` : ''}`
  }

  // content: { text } or { document, mimetype, fileName, caption? }. Resolves { outcome: 'sent' | 'failed' | 'unknown', reason? }.
  // Never throws. 'sent' only on the server ack, not when bytes leave the socket. onMessage(proto) receives the
  // message as built (for a document: media key and URL, not the bytes) so recipient retries can be answered.
  // content: { text } or { document, mimetype, fileName, caption? }. Resolves { outcome, reason?, phase? }. Never throws.
  // With prepareMessage, a document goes in two phases: the upload first (a failure there is CERTAIN: no message
  // was sent, phase 'upload'), then onUploaded() and the relay. 'sent' only on the server ack.
  async function sendContent(jid, content, msgId, onMessage, { onUploaded } = {}) {
    const s = sock
    if (!(content.document && prepareMessage)) {
      return relayAndWait(s, msgId, () => s.sendMessage(jid, content, { messageId: msgId }).then((m) => m?.message && onMessage?.(m.message)))
    }
    if (!s) return { outcome: 'failed', phase: 'upload', reason: `nothing was sent: ${whyUnusable()}` }
    let msg
    try {
      msg = await withTimeout(Promise.resolve().then(() => prepareMessage(s, jid, content, msgId)), uploadTimeoutMs, 'upload')
    } catch (e) {
      return { outcome: 'failed', phase: 'upload', reason: `the upload failed, so nothing was sent (${e.message})` }
    }
    if (s !== sock) return { outcome: 'failed', phase: 'upload', reason: 'the connection was replaced during the upload, so nothing was sent' }
    onMessage?.(msg.message)
    onUploaded?.()
    return relayAndWait(s, msgId, () => s.relayMessage(jid, msg.message, { messageId: msgId }))
  }

  function relayAndWait(s, msgId, relay) {
    return new Promise((resolve) => {
      let timer
      const done = (r) => {
        clearTimeout(timer)
        waiters.delete(msgId)
        resolve(r)
      }
      timer = setTimeout(() => done({ outcome: 'unknown', reason: `no server ack within ${ackTimeoutMs / 1000}s` }), ackTimeoutMs)
      waiters.set(msgId, done)
      if (!s) return done({ outcome: 'unknown', reason: 'connection dropped just before handing the message over' })
      // Anything that goes wrong from here on may already have reached WhatsApp: report unknown, never "not sent".
      Promise.resolve()
        .then(relay)
        .catch((e) => done({ outcome: 'unknown', reason: `send error after handoff: ${e.message}` }))
    })
  }

  // Groups. Live lookups throw for groups we're not in (or that no longer exist).
  const groupMetadata = (jid) => (sock ? withTimeout(sock.groupMetadata(jid), checkTimeoutMs, 'group lookup') : Promise.reject(new Error(whyUnusable())))
  const groupFetchAll = () => (sock ? withTimeout(sock.groupFetchAllParticipating(), 30_000, 'group list') : Promise.reject(new Error(whyUnusable())))

  // Best-effort sends with no ack tracking (reactions, edits). Rejects when there is no socket.
  function sendRaw(jid, content) {
    const s = sock
    if (!s) return Promise.reject(new Error(whyUnusable()))
    return Promise.resolve().then(() => s.sendMessage(jid, content))
  }

  // Best-effort human signals for auto-replies: blue ticks, and online/typing presence. Never throw.
  const markRead = (keys) => Promise.resolve(sock?.readMessages(keys)).catch(() => {})
  const presence = (type, jid) => Promise.resolve(sock?.sendPresenceUpdate(type, jid)).catch(() => {})

  // { ok: true, phone } | { ok: false, reason }. `known` = the JID came from WhatsApp's own contact sync.
  async function checkExists(jid, { known = false } = {}) {
    const s = sock
    if (!s) return { ok: false, reason: whyUnusable() }
    const lookup = async (pnJid) => {
      const [r] = (await withTimeout(s.onWhatsApp(pnJid), checkTimeoutMs, 'WhatsApp number check')) || []
      return r?.exists
    }
    try {
      if (jid.endsWith('@s.whatsapp.net')) {
        return (await lookup(jid)) ? { ok: true, phone: jid.split('@')[0] } : { ok: false, reason: 'this number is not on WhatsApp' }
      }
      const pn = await withTimeout(Promise.resolve(s.signalRepository?.lidMapping?.getPNForLID(jid)), checkTimeoutMs, 'LID lookup')
      if (pn) {
        const digits = pn.split('@')[0].split(':')[0]
        return (await lookup(`${digits}@s.whatsapp.net`)) ? { ok: true, phone: digits } : { ok: false, reason: 'this account is no longer on WhatsApp' }
      }
      if (known) return { ok: true, phone: null }
      return { ok: false, reason: 'unknown LID: it is not in your synced contacts and has no phone mapping' }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  }

  function stop() {
    stopped = true
    clearTimeout(retryTimer)
    retryTimer = null
    teardown()
    set('stopped')
  }

  return {
    connect,
    stop,
    sendContent,
    sendRaw,
    markRead,
    presence,
    groupMetadata,
    groupFetchAll,
    // jid -> GroupMetadata for the send in progress (Baileys' cachedGroupMetadata): the recipients are the ones the
    // user saw in the dialog, not whatever a second lookup returns.
    groupCache: new Map(),
    checkExists,
    usable,
    whyUnusable,
    // "94770000000:12@s.whatsapp.net" -> "94770000000@s.whatsapp.net"
    me: () => sock?.user?.id?.replace(/:\d+@/, '@'),
    // Your own chat as both JID forms (WhatsApp may address it by phone number or by LID).
    self: () => (sock?.user ? { pn: sock.user.id.replace(/:\d+@/, '@'), lid: sock.user.lid?.replace(/:\d+@/, '@') ?? null } : null),
    status: () => ({ state, detail, lastFrameAgoS: lastFrame ? Math.round((now() - lastFrame) / 1000) : null, pendingAcks: waiters.size }),
  }
}
