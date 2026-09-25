#!/usr/bin/env node
// walink: WhatsApp MCP server for Claude Code (Baileys linked device). Design and failure semantics: docs/DESIGN.md
//   node server.js login   -> link by QR (or refresh contacts), then exit
//   node server.js         -> MCP stdio server (stdout is protocol; all logs go to stderr)
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import makeWASocket, { fetchLatestBaileysVersion, generateMessageIDV2, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import qrcode from 'qrcode-terminal'
import { elicitationApprover } from './lib/approval.js'
import { createConnection } from './lib/connection.js'
import { createContactStore } from './lib/contacts.js'
import { createJournal } from './lib/journal.js'
import { acquireLock, releaseLock, startHeartbeat } from './lib/lock.js'
import { log } from './lib/log.js'
import { createSender } from './lib/sender.js'
import { INSTRUCTIONS, registerTools } from './lib/tools.js'

const DIR = process.env.WHATSAPP_MCP_DIR || join(homedir(), '.whatsapp-mcp')
const AUTH = join(DIR, 'auth')
const LOCK = join(DIR, 'auth.lock')
const JOURNAL = join(DIR, 'sends.jsonl')
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
    getMessage: async (key) => {
      const text = sender?.getMessage(key.id)
      return text ? { conversation: text } : undefined
    },
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
  const role = () => ({ owner, holder })

  function tryOwn() {
    const lock = acquireLock(LOCK)
    if (!lock.owner) {
      holder = lock.holder
      return
    }
    owner = true
    holder = null
    stopHeartbeat = startHeartbeat(LOCK)
    contacts.reload()
    journal = createJournal(JOURNAL).load()
    log('info', 'session_owner', { pid: process.pid })
    conn.connect().catch((e) => log('error', 'connect_failed', { err: e.message }))
  }

  const server = new McpServer({ name: 'walink', version: '2.0.0' }, { instructions: INSTRUCTIONS })
  sender = createSender({
    contacts,
    conn,
    role,
    getJournal: () => journal,
    approve: elicitationApprover(server),
    newMsgId: () => generateMessageIDV2(conn.me()),
  })
  registerTools(server, {
    contacts,
    conn,
    sender,
    role,
    getJournal: () => journal,
    elicitationSupported: () => Boolean(server.server.getClientCapabilities()?.elicitation),
  })

  tryOwn()
  if (!owner) {
    log('info', 'session_follower', { ownerPid: holder?.pid })
    const poll = setInterval(() => (owner ? clearInterval(poll) : tryOwn()), 10_000)
  }

  // Exit with the client: an orphaned process would keep holding the WhatsApp session.
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('close', () => shutdown(0))
  await server.connect(new StdioServerTransport())
}
