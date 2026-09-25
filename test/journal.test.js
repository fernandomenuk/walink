import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createJournal, hashText } from '../lib/journal.js'
import { readJsonLines } from '../lib/persist.js'
import { tmp } from './helpers.js'

const J = 'jid@s.whatsapp.net'
const H = hashText('hi')

test('fold: later records win; findUncertain / findRecentSent', () => {
  const file = join(tmp(), 'sends.jsonl')
  const j = createJournal(file).load()
  j.append({ reqId: 'a', state: 'pending', jid: J, textHash: H })
  j.append({ reqId: 'a', state: 'sending', msgId: 'M1' })
  j.append({ reqId: 'a', state: 'unknown', reason: 'ack timeout' })
  j.append({ reqId: 'b', state: 'pending', jid: J, textHash: H })
  j.append({ reqId: 'b', state: 'sending' })
  j.append({ reqId: 'b', state: 'sent' })
  assert.equal(j.get('a').msgId, 'M1')
  assert.equal(j.findUncertain(J, H).reqId, 'a')
  assert.equal(j.findRecentSent(J, H).reqId, 'b')
  assert.equal(j.findUncertain(J, hashText('other')), undefined)
  j.append({ reqId: 'a', resolvedBy: 'c' })
  assert.equal(j.findUncertain(J, H), undefined)
  assert.equal(j.unresolvedUnknown().length, 0)
})

test('never stores the message body', () => {
  const file = join(tmp(), 'sends.jsonl')
  createJournal(file).load().append({ reqId: 'a', state: 'pending', jid: J, textHash: hashText('secret words'), len: 12 })
  assert.ok(!readFileSync(file, 'utf8').includes('secret words'))
})

test('crash recovery: sending -> unknown, pending -> expired, terminal states untouched', () => {
  const file = join(tmp(), 'sends.jsonl')
  const j = createJournal(file).load()
  j.append({ reqId: 's', state: 'pending', jid: J, textHash: H })
  j.append({ reqId: 's', state: 'sending' })
  j.append({ reqId: 'p', state: 'pending', jid: J, textHash: H })
  j.append({ reqId: 'd', state: 'sent', jid: J, textHash: H })
  const after = createJournal(file).load() // "restart"
  assert.equal(after.get('s').state, 'unknown')
  assert.match(after.get('s').reason, /server stopped/)
  assert.equal(after.get('p').state, 'expired')
  assert.equal(after.get('d').state, 'sent')
  assert.equal(after.findUncertain(J, H).reqId, 's')
  // recovery is itself journaled, so a second restart changes nothing
  const lines = readJsonLines(file).length
  createJournal(file).load()
  assert.equal(readJsonLines(file).length, lines)
})

test('torn last line is skipped and the next append starts on a new line', () => {
  const file = join(tmp(), 'sends.jsonl')
  createJournal(file).load().append({ reqId: 'a', state: 'sent', jid: J, textHash: H })
  appendFileSync(file, '{"reqId":"b","state":"send') // crash mid-append
  const j = createJournal(file).load()
  j.append({ reqId: 'c', state: 'sent', jid: J, textHash: H })
  const again = createJournal(file).load()
  assert.equal(again.get('a').state, 'sent')
  assert.equal(again.get('c').state, 'sent')
  assert.equal(again.get('b'), undefined)
})

test('rotation keeps open outcomes and recent records', () => {
  const file = join(tmp(), 'sends.jsonl')
  let t = Date.parse('2026-01-01T00:00:00Z')
  const j = createJournal(file, { now: () => t }).load()
  j.append({ reqId: 'old', state: 'sent', jid: J, textHash: H })
  j.append({ reqId: 'oldunknown', state: 'unknown', jid: J, textHash: H })
  for (let i = 0; i < 50; i++) j.append({ reqId: `x${i}`, state: 'declined', jid: J, textHash: H, pad: 'x'.repeat(100) })
  t += 2 * 24 * 60 * 60 * 1000
  j.append({ reqId: 'new', state: 'sent', jid: J, textHash: H })
  const big = statSync(file).size
  const r = createJournal(file, { now: () => t, maxBytes: 1000 }).load()
  assert.ok(existsSync(`${file}.1`))
  assert.ok(statSync(file).size < big)
  assert.equal(r.get('oldunknown').state, 'unknown')
  assert.equal(r.get('new').state, 'sent')
  assert.equal(createJournal(file, { now: () => t }).load().get('old'), undefined)
})
