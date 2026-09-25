// Failure injection: a real process dies at each point of a send; a fresh process must report the truth.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { createJournal } from '../lib/journal.js'
import { readJsonLines } from '../lib/persist.js'
import { setup, tmp } from './helpers.js'

const CHILD = new URL('./fixtures/crash-send.js', import.meta.url)

async function crashAt(point) {
  const dir = tmp()
  const child = fork(CHILD, [dir, point], { stdio: 'ignore', env: { ...process.env, WA_LOG: 'silent' } })
  const code = await new Promise((r) => child.once('exit', r))
  assert.equal(code, 137, `child should die at ${point}`)
  return dir
}

const lastRecord = (dir) => {
  const recs = readJsonLines(join(dir, 'sends.jsonl'))
  return recs.filter((r) => r.reqId === recs[0].reqId).reduce((a, b) => ({ ...a, ...b }), {})
}

test('crash while waiting for approval: nothing sent, request expires, a new send works', async () => {
  const dir = await crashAt('during-approval')
  assert.equal(lastRecord(dir).state, 'pending')
  const { sender, journal } = await setup({ dir }) // restart
  assert.equal(journal.unresolvedUnknown().length, 0)
  assert.equal(lastRecord(dir).state, 'expired')
  assert.equal((await sender.send({ to: 'Sam', text: 'crash test' })).status, 'SENT')
})

for (const point of ['in-send', 'after-send']) {
  test(`crash ${point === 'in-send' ? 'inside sendMessage' : 'after handoff, before the ack'}: restart reports OUTCOME UNKNOWN and blocks a blind retry`, async () => {
    const dir = await crashAt(point)
    const before = lastRecord(dir)
    assert.equal(before.state, 'sending', 'journaled before the socket was touched')
    assert.ok(before.msgId)

    const { sender, sockets, journal } = await setup({ dir }) // restart
    const unknown = journal.unresolvedUnknown()
    assert.equal(unknown.length, 1)
    assert.equal(unknown[0].msgId, before.msgId)
    assert.match(unknown[0].reason, /server stopped/)

    const retry = await sender.send({ to: 'Sam', text: 'crash test' })
    assert.equal(retry.status, 'NOTHING SENT')
    assert.match(retry.text, new RegExp(`resend_of="${unknown[0].reqId}"`))
    assert.equal(sockets[0].sent.length, 0)

    const resend = await sender.send({ to: 'Sam', text: 'crash test', resend_of: unknown[0].reqId })
    assert.equal(resend.status, 'SENT')
    assert.equal(createJournal(join(dir, 'sends.jsonl')).load().unresolvedUnknown().length, 0)
  })
}
