import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHookHandler, loadNotifySettings, updateNotifySettings } from '../lib/hooks.js'
import { tick, tmp } from './helpers.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function rig({ on = true, minMinutes = 3, notify } = {}) {
  let t = 0
  const sent = []
  const sizes = { tx: 100 }
  const s = { on, minMinutes }
  const h = createHookHandler({
    notify: notify ?? (async (text) => (sent.push(text), { status: 'SENT', text: 'SENT' })),
    settings: () => s,
    now: () => t,
    delayMs: 10,
    fileSize: (f) => sizes[f] ?? null,
  })
  return { h, sent, sizes, s, advance: (min) => (t += min * 60_000) }
}

test('a long turn pings with a trimmed summary; a short one does not', async () => {
  const r = rig()
  r.h.handle({ event: 'start' })
  r.advance(7)
  r.h.handle({ event: 'stop', message: 'x'.repeat(500) })
  await tick()
  assert.equal(r.sent.length, 1)
  assert.match(r.sent[0], /^✅ Done after 7 min\nx{300}…$/)

  r.h.handle({ event: 'start' })
  r.advance(1)
  r.h.handle({ event: 'stop', message: 'quick' })
  await tick()
  assert.equal(r.sent.length, 1)
})

test('no ping: stop without start, setting off, or Claude already notified this turn', async () => {
  const r = rig()
  r.h.handle({ event: 'stop', message: 'hi' })
  r.h.handle({ event: 'start' })
  r.h.markNotified()
  r.advance(10)
  r.h.handle({ event: 'stop', message: 'hi' })
  r.s.on = false
  r.h.handle({ event: 'start' })
  r.advance(10)
  r.h.handle({ event: 'stop', message: 'hi' })
  await tick()
  assert.deepEqual(r.sent, [])
})

test('a prompt left waiting pings; an answered one (transcript grew) or a new turn does not', async () => {
  const r = rig()
  r.h.handle({ event: 'waiting', kind: 'permission_prompt', message: 'Claude needs your permission to use Bash', transcript: 'tx' })
  await wait(30)
  assert.deepEqual(r.sent, ['⏸ Waiting for you: Claude needs your permission to use Bash'])

  r.h.handle({ event: 'waiting', kind: 'elicitation_dialog', transcript: 'tx' })
  r.sizes.tx = 200
  await wait(30)
  r.h.handle({ event: 'waiting', kind: 'elicitation_dialog', transcript: 'tx' })
  r.h.handle({ event: 'start' })
  await wait(30)
  assert.equal(r.sent.length, 1)

  r.h.handle({ event: 'waiting', kind: 'elicitation_dialog', transcript: 'tx' })
  await wait(30)
  assert.equal(r.sent[1], '⏸ A send is waiting for your approval')
})

test('a failing notify never throws out of the hook', async () => {
  const r = rig({ notify: async () => { throw new Error('boom') } })
  r.h.handle({ event: 'start' })
  r.advance(5)
  assert.doesNotThrow(() => r.h.handle({ event: 'stop', message: 'x' }))
  assert.doesNotThrow(() => r.h.handle({ event: 'bogus' }))
  await tick()
})

test('notify settings: defaults, on/off, minutes, bad arg', () => {
  const dir = tmp()
  assert.deepEqual(loadNotifySettings(dir), { on: true, minMinutes: 3 })
  assert.deepEqual(updateNotifySettings(dir, 'off'), { on: false, minMinutes: 3 })
  assert.deepEqual(updateNotifySettings(dir, '5'), { on: true, minMinutes: 5 })
  assert.deepEqual(loadNotifySettings(dir), { on: true, minMinutes: 5 })
  assert.equal(updateNotifySettings(dir, 'loud'), null)
})
