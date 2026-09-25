// Test doubles: a scriptable fake Baileys socket and a wired-up sender over real modules.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from '../lib/connection.js'
import { createContactStore } from '../lib/contacts.js'
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
export function fakeSocket({ behavior = () => 'ack', missing = [], lidMap = {} } = {}) {
  const s = {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    user: { id: '94770000000:7@s.whatsapp.net' },
    sent: [],
    ended: false,
    onWhatsApp: async (jid) => [{ jid, exists: !missing.includes(jid) }],
    signalRepository: { lidMapping: { getPNForLID: async (lid) => lidMap[lid] ?? null } },
    async sendMessage(jid, content, { messageId }) {
      s.sent.push({ jid, text: content.text, messageId })
      const b = behavior(messageId, s)
      if (b === 'throw') throw new Error('Connection Closed')
      if (b === 'ack') setImmediate(() => s.ws.emit('CB:ack,class:message', { attrs: { id: messageId, class: 'message' } }))
      if (b === 'nack') setImmediate(() => s.ws.emit('CB:ack,class:message', { attrs: { id: messageId, error: '463' } }))
      if (b === 'close') setImmediate(() => s.close(428))
      return { key: { id: messageId } }
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
  return s
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
export async function setup({ approve = async () => ({ ok: true }), sock = {}, dir = tmp(), owner = true, senderOpts = {} } = {}) {
  writeJsonAtomic(join(dir, 'contacts.json'), CONTACTS)
  const contacts = createContactStore(dir)
  const journal = createJournal(join(dir, 'sends.jsonl')).load()
  const { conn, sockets } = await connected(sock)
  const previews = []
  let n = 0
  const sender = createSender({
    contacts,
    conn,
    getJournal: () => (owner ? journal : null),
    role: () => (owner ? { owner: true } : { owner: false, holder: { pid: 4242 } }),
    approve: async (p) => {
      previews.push(p)
      return approve(p)
    },
    newMsgId: () => `MSG${++n}`,
    minGapMs: 0,
    sleep: tick,
    ...senderOpts,
  })
  return { sender, conn, sockets, contacts, journal, previews, dir }
}
