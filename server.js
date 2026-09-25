#!/usr/bin/env node
// walink: WhatsApp MCP server for Claude Code (Baileys linked device). Design and failure semantics: docs/DESIGN.md
//   node server.js login   -> link by QR (or refresh contacts), then exit
//   node server.js         -> MCP stdio server (stdout is protocol; all logs go to stderr)
import { mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import makeWASocket, { fetchLatestBaileysVersion, generateMessageIDV2, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import qrcode from 'qrcode-terminal'
import { elicitationApprover } from './lib/approval.js'
import { createConnection } from './lib/connection.js'
import { createContactStore } from './lib/contacts.js'
import { createJournal } from './lib/journal.js'
import { createPhone } from './lib/phone.js'
import { acquireLock, clearHandover, declineHandover, handoverFile, handoverRequest, isAlive, releaseLock, requestHandover, startHeartbeat } from './lib/lock.js'
import { log } from './lib/log.js'
import { createSender } from './lib/sender.js'
import { INSTRUCTIONS, registerTools } from './lib/tools.js'
import pkg from './package.json' with { type: 'json' }

const DIR = process.env.WHATSAPP_MCP_DIR || join(homedir(), '.whatsapp-mcp')
const AUTH = join(DIR, 'auth')
const LOCK = join(DIR, 'auth.lock')
const JOURNAL = join(DIR, 'sends.jsonl')
const HANDOVER = handoverFile(LOCK)
mkdirSync(DIR, { recursive: true })
const LOGIN = process.argv[2] === 'login'

// Baileys' default pino logger writes to stdout, which would corrupt the MCP stream. Keep only error messages.
const quiet = () => {}
const baileysLogger = {
  level: 'error',
  child: () => baileysLogger,
  trace: quiet,
  debug: quiet,
  info: quiet,
  warn: quiet,
  error: (o, m) => log('error', 'baileys', { msg: m || o?.err?.message || o?.error?.message || String(o).slice(0, 200) }),
}

const contacts = createContactStore(DIR)
let sender = null
let phone = null
let version
const makeSocket = async (auth) => {
  version ??= (await fetchLatestBaileysVersion().catch(() => ({}))).version
  return makeWASocket({
    auth,
    version,
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // lets Baileys re-encrypt a message a recipient device failed to decrypt (same id, so never a duplicate)
    getMessage: async (key) => sender?.getMessage(key.id),
  })
}

let stopHeartbeat = null
let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    contacts.flush()
  } catch (e) {
    log('error', 'contacts_flush_failed', { err: e.message })
  }
  conn.stop()
  stopHeartbeat?.()
  releaseLock(LOCK)
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => releaseLock(LOCK))
process.on('unhandledRejection', (e) => log('error', 'unhandled_rejection', { err: String(e?.message ?? e) }))

let onSyncActivity = () => {}
const conn = createConnection({
  authDir: AUTH,
  loadAuth: useMultiFileAuthState,
  makeSocket,
  login: LOGIN,
  onMessages: (u) => phone?.onMessages(u),
  onContacts: (list) => {
    contacts.upsert(list)
    onSyncActivity()
  },
  onQr: (qr) => {
    console.clear()
    qrcode.generate(qr, { small: true })
    console.log('Scan with WhatsApp > Settings > Linked devices > Link a device')
  },
  onOpen: () => LOGIN && waitForSync(),
  onTerminal: (code) => {
    if (!LOGIN) return
    // Dead or corrupt credentials: wipe them so a fresh QR code appears.
    if (code === 401 || code === 500) return void rm(AUTH, { recursive: true, force: true }).then(() => conn.connect())
    console.error(conn.whyUnusable())
    shutdown(1)
  },
})

// Login mode: exit once contact events go quiet for 20s after connecting.
function waitForSync() {
  console.log('Linked. Syncing contacts...')
  let timer
  onSyncActivity = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      contacts.flush()
      console.log(`Done: ${contacts.size} contacts saved in ${DIR}`)
      shutdown(0)
    }, 20_000)
  }
  onSyncActivity()
}

if (LOGIN) {
  const lock = acquireLock(LOCK)
  if (!lock.owner) {
    console.error(`WhatsApp is in use by another process (pid ${lock.holder?.pid}). Close the Claude Code sessions using it, then retry.`)
    process.exit(1)
  }
  stopHeartbeat = startHeartbeat(LOCK)
  await conn.connect()
} else {
  let owner = false
  let holder = null
  let journal = null
  let watch = null
  let poll = null
  let ownerSince = 0
  const role = () => ({ owner, holder })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function tryOwn() {
    const lock = acquireLock(LOCK)
    if (!lock.owner) {
      holder = lock.holder
      return
    }
    owner = true
    ownerSince = Date.now()
    holder = null
    stopHeartbeat = startHeartbeat(LOCK)
    contacts.reload()
    journal = createJournal(JOURNAL).load()
    log('info', 'session_owner', { pid: process.pid })
    conn.connect().catch((e) => log('error', 'connect_failed', { err: e.message }))
    watch = setInterval(checkHandover, 1000)
    watch.unref()
  }

  // Follower: poll for a dead owner. Don't grab the lock while another live session is taking over.
  function follow() {
    poll ??= setInterval(() => {
      if (owner) return void (clearInterval(poll), (poll = null))
      const req = handoverRequest(HANDOVER)
      if (!req || req.pid === process.pid) tryOwn()
    }, 10_000)
  }

  // Owner: another session's user approved a send there. Stop taking sends, let in-flight ones finish
  // (so the handover never causes an OUTCOME UNKNOWN), then release the session and follow.
  // ponytail: the old owner may still append late `rejected` lines to sends.jsonl after the new owner loaded it;
  // they are single small appends, so harmless. A journal per owner if that ever matters.
  let releasing = false
  async function checkHandover() {
    const req = handoverRequest(HANDOVER)
    if (!owner || releasing || !req || req.pid === process.pid || req.declined) return
    // A notification or question from another session must not cut off a question you're about to answer here.
    if (req.soft && phone.waiting()) return declineHandover(HANDOVER, `the ${sessionLabel} session is waiting for your WhatsApp reply`)
    releasing = true
    owner = false
    log('info', 'handover_requested', { byPid: req.pid })
    phone.endWaits(`WhatsApp moved to another Claude Code session (pid ${req.pid})`)
    await sender.idle()
    clearInterval(watch)
    conn.stop()
    stopHeartbeat?.()
    stopHeartbeat = null
    contacts.flush()
    journal = null
    releaseLock(LOCK)
    holder = { pid: req.pid }
    releasing = false
    log('info', 'handover_released', { toPid: req.pid })
    follow()
  }

  // Follower: the user approved "take over and send". Ask the owner to step down, then own and connect.
  async function takeOver({ soft = false } = {}) {
    const from = holder?.pid
    requestHandover(HANDOVER, process.pid, { soft })
    try {
      const deadline = Date.now() + 30_000
      while (!owner) {
        if (Date.now() > deadline) {
          const other = holder?.pid && holder.pid !== from && isAlive(holder.pid)
          return { ok: false, reason: other ? `another session (pid ${holder.pid}) took over WhatsApp first` : `the other session (pid ${from ?? '?'}) did not hand WhatsApp over within 30s` }
        }
        await sleep(500)
        const declined = handoverRequest(HANDOVER)?.declined
        if (declined) return { ok: false, reason: `${declined}; try again after that question is answered` }
        tryOwn()
      }
      const until = Date.now() + 20_000
      while (!conn.usable()) {
        if (Date.now() > until) return { ok: false, reason: `this session took over WhatsApp, but ${conn.whyUnusable()}` }
        await sleep(500)
      }
      return { ok: true }
    } finally {
      clearHandover(HANDOVER)
    }
  }

  // Own chat ID from the linked-device credentials, readable while following.
  function selfJid() {
    try {
      return JSON.parse(readFileSync(join(AUTH, 'creds.json'), 'utf8')).me?.id?.replace(/:\d+@/, '@') ?? null
    } catch {
      return null
    }
  }

  // Names this session in phone messages: the folder Claude Code was started in.
  const sessionLabel = (process.cwd() !== homedir() && basename(process.cwd())) || 'Claude Code'
  // claude/channel: lets walink push your phone replies and "@claude" messages into the session.
  const server = new McpServer(
    { name: 'walink', version: pkg.version },
    { instructions: INSTRUCTIONS, capabilities: { experimental: { 'claude/channel': {} } } },
  )
  sender = createSender({
    contacts,
    conn,
    role,
    getJournal: () => journal,
    approve: elicitationApprover(server),
    takeOver,
    selfJid,
    sessionLabel,
    newMsgId: () => generateMessageIDV2(conn.me()),
  })
  phone = createPhone({
    conn,
    sender,
    getJournal: () => journal,
    sessionLabel,
    ownerSince: () => ownerSince,
    pushChannel: (params) =>
      server.server.notification({ method: 'notifications/claude/channel', params }).catch((e) => log('warn', 'channel_push_failed', { err: e.message })),
  })
  registerTools(server, {
    contacts,
    conn,
    sender,
    phone,
    sessionLabel,
    role,
    getJournal: () => journal,
    elicitationSupported: () => Boolean(server.server.getClientCapabilities()?.elicitation),
  })

  tryOwn()
  if (!owner) {
    log('info', 'session_follower', { ownerPid: holder?.pid })
    follow()
  }

  // Exit with the client: an orphaned process would keep holding the WhatsApp session.
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('close', () => shutdown(0))
  await server.connect(new StdioServerTransport())
}
