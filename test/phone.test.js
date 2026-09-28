import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPhone } from '../lib/phone.js'
import { setup, tick } from './helpers.js'

const SELF = '94770000000@s.whatsapp.net'
const SELF_LID = '11111111111111@lid'
let n = 0

// A message as Baileys delivers it. Defaults: typed by you, in your own chat, just now.
function incoming(text, { jid = SELF, fromMe = true, quote, forwarded, ts = Date.now(), id = `IN${++n}`, message } = {}) {
  const ctx = { ...(quote && { stanzaId: quote }), ...(forwarded && { isForwarded: true }) }
  return {
    key: { remoteJid: jid, fromMe, id },
    messageTimestamp: Math.floor(ts / 1000),
    message: message ?? (quote || forwarded ? { extendedTextMessage: { text, contextInfo: ctx } } : { conversation: text }),
  }
}

async function phoneSetup({ ownerSince = 0, now, listening, peers } = {}) {
  const h = await setup({ senderOpts: { sessionLabel: 'proj' } })
  const pushed = []
  const phone = createPhone({ conn: h.conn, sender: h.sender, getJournal: () => h.journal, pushChannel: (p) => pushed.push(p), sessionLabel: 'proj', ownerSince: () => ownerSince, now, listening: listening && (() => listening()), peers })
  const recv = async (...msgs) => {
    phone.onMessages({ messages: msgs, type: 'notify' })
    await tick(10)
  }
  const sock = h.sockets[0]
  return { ...h, phone, pushed, recv, sock }
}

// Ask, and wait until the question message went out. Returns { result }: the ask's eventual outcome.
async function asked(phone, sock, args) {
  const before = sock.sent.length
  const result = phone.ask({ waitMs: 5_000, ...args })
  while (sock.sent.length === before) await tick(5)
  await tick(10)
  return { result }
}

test('ask: the question goes to your own chat; a reply with a number picks the option', async () => {
  const { phone, sock, recv, journal, dir, previews } = await phoneSetup()
  const { result: p } = await asked(phone, sock, { question: 'Drop users.legacy_id?', options: ['yes, drop it', 'no, keep it'] })
  assert.equal(sock.sent[0].jid, SELF)
  assert.equal(sock.sent[0].text, '🤖 walink · proj asks:\nDrop users.legacy_id?\n\n1) yes, drop it\n2) no, keep it\nReply with a number or your own words.')
  assert.equal(previews.length, 0, 'no approval dialog')
  await recv(incoming('2'))
  const r = await p
  assert.equal(r.status, 'REPLY')
  assert.equal(r.text, 'REPLY (question Q1): no, keep it (option 2)')
  assert.equal(sock.reactions.at(-1).text, '✅')
  assert.equal(journal.get('Q1').state, 'answered')
  assert.ok(!readFileSync(join(dir, 'sends.jsonl'), 'utf8').includes('legacy_id'), 'the journal never stores message text')
})

test('ask: free text passes through; an out-of-range number is text too', async () => {
  const { phone, sock, recv } = await phoneSetup()
  const { result: p } = await asked(phone, sock, { question: 'Which port?', options: ['8080'] })
  await recv(incoming('7'))
  assert.equal((await p).text, 'REPLY (question Q1): 7')
})

test('ask: no reply in time -> NO REPLY YET; a late reply is pushed as a channel answer and kept for wait_for', async () => {
  const { phone, sock, recv, pushed } = await phoneSetup()
  const r = await (await asked(phone, sock, { question: 'Deploy now?', waitMs: 30 })).result
  assert.equal(r.status, 'NO REPLY YET')
  assert.match(r.text, /question Q1 is still open.*wait_for="Q1"/)
  await recv(incoming('yes go'))
  assert.deepEqual(pushed, [{ content: 'Reply to "Deploy now?": yes go', meta: { kind: 'answer', question_id: 'Q1' } }])
  assert.equal((await phone.ask({ waitFor: 'Q1' })).text, 'REPLY (question Q1): yes go')
})

test('ask: wait_for keeps waiting for an open question', async () => {
  const { phone, sock, recv } = await phoneSetup()
  await (await asked(phone, sock, { question: 'Deploy now?', waitMs: 20 })).result
  const p = phone.ask({ waitFor: 'Q1', waitMs: 5_000 })
  await recv(incoming('later'))
  assert.equal((await p).text, 'REPLY (question Q1): later')
  assert.match((await phone.ask({ waitFor: 'Q7' })).text, /no question Q7/)
})

test('matching: a swipe-reply picks its question; otherwise the newest open one', async () => {
  const { phone, sock, recv } = await phoneSetup()
  const { result: q1 } = await asked(phone, sock, { question: 'First?' })
  const { result: q2 } = await asked(phone, sock, { question: 'Second?' })
  assert.match(sock.sent.at(-1).text, /Several questions are open: swipe-reply/)
  await recv(incoming('answer to first', { quote: sock.sent[0].messageId }))
  await recv(incoming('answer to newest'))
  assert.equal((await q1).text, 'REPLY (question Q1): answer to first')
  assert.equal((await q2).text, 'REPLY (question Q2): answer to newest')
})

test('filters: only your own new, typed, non-forwarded messages in your own chat count', async () => {
  const { phone, sock, recv, pushed } = await phoneSetup()
  const { result: p } = await asked(phone, sock, { question: 'Go?' })
  const questionId = sock.sent[0].messageId
  await recv(incoming('yes', { jid: '94771111111@s.whatsapp.net' })) // another chat
  await recv(incoming('yes', { fromMe: false })) // not typed by you
  await recv(incoming('yes', { id: questionId })) // walink's own question echoing back
  phone.onMessages({ messages: [incoming('yes')], type: 'append' }) // history sync, not new
  await recv(incoming('yes', { forwarded: true })) // written by someone else
  assert.equal(sock.reactions.at(-1).text, '⚠️')
  assert.equal(pushed.length, 0)
  const dup = incoming('yes, via LID', { jid: SELF_LID })
  await recv(dup, dup)
  assert.equal((await p).text, 'REPLY (question Q1): yes, via LID')
})

test('filters: a photo while a question is open gets a text-only notice', async () => {
  const { phone, sock, recv } = await phoneSetup()
  await (await asked(phone, sock, { question: 'Go?', waitMs: 20 })).result
  await recv(incoming(null, { message: { imageMessage: { caption: '' } } }))
  await tick(20)
  assert.match(sock.sent.at(-1).text, /only text replies are supported/)
})

test('@claude: pushed with the prefix removed; plain notes stay private; old ones are not replayed', async () => {
  const { recv, pushed, sock } = await phoneSetup({ ownerSince: Date.now() })
  await recv(incoming('buy milk'))
  await recv(incoming('@claude run the linter'))
  await recv(incoming('@CLAUDE: status?'))
  await recv(incoming('@claude old command', { ts: Date.now() - 60 * 60_000 }))
  await recv(incoming('@claude'))
  assert.deepEqual(pushed, [
    { content: 'run the linter', meta: { kind: 'message' } },
    { content: 'status?', meta: { kind: 'message' } },
  ])
  assert.deepEqual(sock.reactions.map((r) => r.text), ['👀', '👀'])
})

test('closed and foreign questions get a notice instead of being delivered', async () => {
  const { phone, sock, recv, journal, pushed } = await phoneSetup()
  await (await asked(phone, sock, { question: 'Old?', waitMs: 20 })).result
  await recv(incoming('first answer'))
  await recv(incoming('again', { quote: sock.sent[0].messageId }))
  await tick(20)
  assert.match(sock.sent.at(-1).text, /already closed/)
  journal.append({ reqId: 'Q9', type: 'question', state: 'open', msgId: 'FOREIGN', sentAt: Date.now(), owner: { pid: process.ppid, label: 'other-proj' } })
  await recv(incoming('hi', { quote: 'FOREIGN' }))
  await tick(20)
  assert.match(sock.sent.at(-1).text, /belongs to the other-proj session/)
  assert.equal(pushed.length, 1, 'only the first answer was delivered')
})

test('cancel (Esc): CANCELLED, question closed, and edited on WhatsApp', async () => {
  const { phone, sock, journal } = await phoneSetup()
  const ac = new AbortController()
  const { result: p } = await asked(phone, sock, { question: 'Go?', signal: ac.signal })
  ac.abort()
  assert.equal((await p).status, 'CANCELLED')
  assert.equal(journal.get('Q1').state, 'cancelled')
  assert.match(sock.edits[0].text, /\(answered at the computer\)$/)
})

test('questions expire after 24h; a later unquoted reply is just a private note', async () => {
  let t = Date.now()
  const { phone, sock, recv, pushed, journal } = await phoneSetup({ now: () => t })
  await (await asked(phone, sock, { question: 'Go?', waitMs: 20 })).result
  t += 25 * 60 * 60_000
  await recv(incoming('yes', { ts: t }))
  assert.equal(journal.get('Q1').state, 'expired')
  assert.equal(pushed.length, 0)
})

test('handover: waiting calls end with a clear reason', async () => {
  const { phone, sock } = await phoneSetup()
  const { result: p } = await asked(phone, sock, { question: 'Go?' })
  assert.equal(phone.waiting(), true)
  phone.endWaits('WhatsApp moved to another Claude Code session (pid 99)')
  const r = await p
  assert.equal(r.status, 'NO REPLY YET')
  assert.match(r.text, /moved to another Claude Code session \(pid 99\)/)
})

// Channels: what happens when the session holding WhatsApp can't push into Claude Code.
const notices = (sock) => sock.sent.map((m) => m.text)

test('not listening, no other session can: ⚠️ and a notice with the command to fix it, nothing pushed', async () => {
  const { recv, pushed, sock } = await phoneSetup({ listening: () => false })
  await recv(incoming('@claude run the linter'))
  await tick(20)
  assert.equal(pushed.length, 0)
  assert.deepEqual(sock.reactions.map((r) => r.text), ['⚠️'])
  assert.match(notices(sock).at(-1), /nothing received this\. The proj session holds WhatsApp but was started without phone messages/)
  assert.match(notices(sock).at(-1), /claude --dangerously-load-development-channels plugin:walink@walink/)
})

test('not listening, another session can: the notice names it and says to resend', async () => {
  const peers = () => [
    { pid: process.pid, label: 'proj', channels: false },
    { pid: 7, label: 'other-proj', channels: false },
    { pid: 8, label: 'api', channels: true },
  ]
  const { recv, pushed, sock } = await phoneSetup({ listening: () => false, peers })
  await recv(incoming('@claude status?'))
  await tick(20)
  assert.equal(pushed.length, 0)
  assert.match(notices(sock).at(-1), /reached the proj session, which can't receive phone messages\. The api session can; .*Send it again then\./)
})

test('listening unknown: pushed as before, no warning (never a false alarm)', async () => {
  const { recv, pushed, sock } = await phoneSetup({ listening: () => null })
  await recv(incoming('@claude hi'))
  assert.deepEqual(pushed, [{ content: 'hi', meta: { kind: 'message' } }])
  assert.deepEqual(sock.reactions.map((r) => r.text), ['👀'])
  assert.equal(sock.sent.length, 0)
})

test('not listening: plain notes stay private, with no reply', async () => {
  const { recv, sock } = await phoneSetup({ listening: () => false })
  await recv(incoming('buy milk'))
  await tick(20)
  assert.equal(sock.sent.length, 0)
  assert.equal(sock.reactions.length, 0)
})

test('not listening: a late answer is saved (✅), the notice names the question, wait_for still gets it', async () => {
  let listening = true
  const { phone, sock, recv, pushed } = await phoneSetup({ listening: () => listening })
  await (await asked(phone, sock, { question: 'Deploy now?', waitMs: 20 })).result
  listening = false
  await recv(incoming('yes go'))
  await tick(20)
  assert.equal(pushed.length, 0)
  assert.equal(sock.reactions.at(-1).text, '✅')
  assert.match(notices(sock).at(-1), /saved\. The proj session can't receive phone messages, so it sees this reply only when it checks question Q1/)
  assert.equal((await phone.ask({ waitFor: 'Q1' })).text, 'REPLY (question Q1): yes go')
})

test('not listening: an answer to a question being waited on returns normally, no notice', async () => {
  const { phone, sock, recv } = await phoneSetup({ listening: () => false })
  const { result: p } = await asked(phone, sock, { question: 'Go?' })
  const sentBefore = sock.sent.length
  await recv(incoming('yes'))
  assert.equal((await p).text, 'REPLY (question Q1): yes')
  await tick(20)
  assert.equal(sock.sent.length, sentBefore)
})
