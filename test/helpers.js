// Test doubles: a scriptable fake Baileys socket and a wired-up sender over real modules.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from '../lib/connection.js'
import { createContactStore } from '../lib/contacts.js'
import { createGroupStore, resolveTarget } from '../lib/groups.js'
import { createJournal } from '../lib/journal.js'
import { writeJsonAtomic } from '../lib/persist.js'
import { createSender } from '../lib/sender.js'

process.env.WA_LOG = 'silent'

export const tmp = () => mkdtempSync(join(tmpdir(), 'wa-test-'))
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

export const CONTACTS = [
  { jid: '94771111111@s.whatsapp.net', name: 'Nabeel Ahmed', phone: '94771111111' },
  { jid: '94772222222@s.whatsapp.net', name: 'John Smith', phone: '94772222222' },
  { jid: '94773333333@s.whatsapp.net', notify: 'John Doe', phone: '94773333333' },
  { jid: '94774444444@s.whatsapp.net', name: 'Sam', phone: '94774444444' },
  { jid: '94775555555@s.whatsapp.net', name: 'Samantha', phone: '94775555555' },
  { jid: '123456789012345@lid', name: 'Lid Friend' },
  { jid: '555555555555555@lid', name: 'Mapped Lid' },
]

// behavior(msgId, sock) -> 'ack' | 'nack' | 'hang' | 'throw' | 'close'
// groups: { [jid]: GroupMetadata } answered by groupMetadata / groupFetchAllParticipating (missing jid -> throws).
// failUpload: prepareMessage (the split media upload, see fakePrepare) throws.
export function fakeSocket({ behavior = () => 'ack', missing = [], lidMap = {}, groups = {}, failUpload = false } = {}) {
  const s = {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    user: { id: '94770000000:7@s.whatsapp.net', lid: '11111111111111:7@lid' },
    sent: [],
    reactions: [], // { jid, text, key } from best-effort sendRaw
    edits: [], // { jid, text, key }
    ended: false,
    onWhatsApp: async (jid) => [{ jid, exists: !missing.includes(jid) }],
    signalRepository: { lidMapping: { getPNForLID: async (lid) => lidMap[lid] ?? null } },
    groupMeta: groups,
    failUpload,
    prepared: new Map(), // msgId -> content, from fakePrepare
    cachedAtSend: [], // what cachedGroupMetadata held when each group message went out
    groupMetadata: async (jid) => {
      if (!groups[jid]) throw new Error('item-not-found')
      return groups[jid]
    },
    groupFetchAllParticipating: async () => ({ ...groups }),
    async sendMessage(jid, content, { messageId } = {}) {
      if (content.react) return void s.reactions.push({ jid, text: content.react.text, key: content.react.key })
      if (content.edit) return void s.edits.push({ jid, text: content.text, key: content.edit })
      s.sent.push(content.document ? { jid, ...content, messageId } : { jid, text: content.text, messageId })
      return outcome(messageId, content)
    },
    // The relay half of a split media send (prepareMessage uploaded first).
    async relayMessage(jid, message, { messageId }) {
      s.sent.push({ jid, ...s.prepared.get(messageId), messageId })
      return outcome(messageId, s.prepared.get(messageId)).key.id
    },
    end() {
      s.ended = true
    },
    open() {
      s.ev.emit('connection.update', { connection: 'open' })
    },
    close(code) {
      s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } })
    },
  }
  function outcome(messageId, content) {
    if (s.cachedGroupMetadata) s.cachedAtSend.push(s.cachedGroupMetadata())
    const b = behavior(messageId, s)
    if (b === 'throw') throw new Error('Connection Closed')
    if (b === 'ack') setImmediate(() => s.ws.emit('CB:ack,class:message', { attrs: { id: messageId, class: 'message' } }))
    if (b === 'nack') setImmediate(() => s.ws.emit('CB:ack,class:message', { attrs: { id: messageId, error: '463' } }))
    if (b === 'close') setImmediate(() => s.close(428))
    const message = content?.document ? { documentMessage: { fileName: content.fileName, mediaKey: 'KEY' } } : { conversation: content?.text }
    return { key: { id: messageId }, message }
  }
  return s
}

// Stand-in for Baileys' generateWAMessage: "uploads" (or fails to), then the relay half sends it.
export async function fakePrepare(s, jid, content, msgId) {
  if (s.failUpload) throw new Error('upload timed out')
  s.prepared.set(msgId, content)
  return { message: { documentMessage: { fileName: content.fileName, mediaKey: 'KEY' } } }
}

export const fakeAuth = (linked = true) => async () => ({ state: { creds: linked ? { me: { id: '94770000000:7@s.whatsapp.net' } } : {} }, saveCreds: async () => {} })

// A connected connection whose socket(s) come from `sockets` (array, one per connect) or a factory.
export async function connected(opts = {}, connOpts = {}) {
  const sockets = []
  const conn = createConnection({
    authDir: 'unused',
    loadAuth: fakeAuth(),
    makeSocket: async () => {
      const s = fakeSocket(opts)
      sockets.push(s)
      return s
    },
    ackTimeoutMs: 200,
    ...connOpts,
  })
  await conn.connect()
  sockets[0].open()
  return { conn, sockets }
}

// Full sender over real contacts/journal/connection with a scripted approver.
export async function setup({ approve = async () => ({ ok: true }), sock = {}, dir = tmp(), owner = true, senderOpts = {}, connOpts = {} } = {}) {
  writeJsonAtomic(join(dir, 'contacts.json'), CONTACTS)
  const contacts = createContactStore(dir)
  const journal = createJournal(join(dir, 'sends.jsonl')).load()
  const groups = createGroupStore(dir)
  const { conn, sockets } = await connected(sock, connOpts)
  // What Baileys' cachedGroupMetadata would read during a send: lets tests check the dialog-time metadata was used.
  sockets[0].cachedGroupMetadata = () => [...conn.groupCache.values()][0] ?? null
  const previews = []
  const approveOpts = []
  let n = 0
  let isOwner = owner
  const sender = createSender({
    contacts,
    conn,
    getJournal: () => (isOwner ? journal : null),
    role: () => (isOwner ? { owner: true } : { owner: false, holder: { pid: 4242 } }),
    approve: async (p, o) => {
      previews.push(p)
      approveOpts.push(o ?? {})
      return approve(p, o)
    },
    resolveTo: (to) => resolveTarget(to, contacts, groups),
    groups,
    newMsgId: () => `MSG${++n}`,
    minGapMs: 0,
    sleep: tick,
    ...senderOpts,
  })
  return { sender, conn, sockets, contacts, groups, journal, previews, approveOpts, dir, setOwner: (v) => (isOwner = v) }
}
