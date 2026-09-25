import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoffMs, createConnection } from '../lib/connection.js'
import { connected, fakeAuth, fakeSocket, tick } from './helpers.js'

test('backoff: exponential, capped at 60s, ±20% jitter', () => {
  assert.equal(backoffMs(0, () => 0.5), 1000)
  assert.equal(backoffMs(3, () => 0.5), 8000)
  assert.equal(backoffMs(20, () => 0.5), 60000)
  assert.equal(backoffMs(0, () => 0), 800)
  assert.equal(backoffMs(0, () => 1), 1200)
})

test('sendContent: sent only on the server ack', async () => {
  const { conn } = await connected()
  assert.deepEqual(await conn.sendContent('1@s.whatsapp.net', { text: 'hi' }, 'M1'), { outcome: 'sent' })
})

test('sendContent: error ack -> failed; no ack -> unknown; throw -> unknown; close -> unknown', async () => {
  const cases = { nack: 'failed', hang: 'unknown', throw: 'unknown', close: 'unknown' }
  for (const [behavior, outcome] of Object.entries(cases)) {
    const { conn } = await connected({ behavior: () => behavior }, { ackTimeoutMs: 50 })
    const r = await conn.sendContent('1@s.whatsapp.net', { text: 'hi' }, 'M1')
    assert.equal(r.outcome, outcome, behavior)
    conn.stop()
  }
})

test('terminal close codes stop reconnecting', async () => {
  for (const [code, state] of [[401, 'logged_out'], [403, 'forbidden'], [440, 'conflict'], [500, 'bad_session']]) {
    const sockets = []
    const conn = createConnection({ authDir: 'x', loadAuth: fakeAuth(), makeSocket: async () => (sockets.push(fakeSocket()), sockets.at(-1)) })
    await conn.connect()
    sockets[0].open()
    sockets[0].close(code)
    await tick(30)
    assert.equal(conn.status().state, state, `code ${code}`)
    assert.equal(sockets.length, 1, `code ${code} must not reconnect`)
    assert.equal(conn.usable(), false)
  }
})

test('transient close reconnects with backoff; 515 reconnects immediately', async () => {
  for (const [code, rand] of [[408, () => 0], [515, () => 0]]) {
    const sockets = []
    const conn = createConnection({ authDir: 'x', loadAuth: fakeAuth(), makeSocket: async () => (sockets.push(fakeSocket()), sockets.at(-1)), rand })
    await conn.connect()
    sockets[0].open()
    sockets[0].close(code)
    assert.equal(conn.status().state, 'reconnecting')
    await tick(code === 515 ? 20 : 900) // 408 first retry = 1000ms * 0.8
    assert.equal(sockets.length, 2, `code ${code}`)
    sockets[1].open()
    assert.equal(conn.status().state, 'connected')
    conn.stop()
  }
})

test('single-flight: concurrent connects and duplicate/stale closes make one socket', async () => {
  const sockets = []
  const conn = createConnection({ authDir: 'x', loadAuth: fakeAuth(), makeSocket: async () => (sockets.push(fakeSocket()), sockets.at(-1)), rand: () => 0 })
  await Promise.all([conn.connect(), conn.connect(), conn.connect()])
  assert.equal(sockets.length, 1)
  sockets[0].open()
  sockets[0].close(408)
  sockets[0].close(408) // duplicate close from the same (now stale) socket is ignored
  await tick(900)
  assert.equal(sockets.length, 2)
  sockets[1].open()
  sockets[0].close(428) // late event from the old socket must not trigger another reconnect
  await tick(900)
  assert.equal(sockets.length, 2)
  assert.equal(conn.status().state, 'connected')
  conn.stop()
})

test('a close mid-send resolves the pending send as unknown', async () => {
  const { conn, sockets } = await connected({ behavior: () => 'hang' }, { ackTimeoutMs: 5000 })
  const p = conn.sendContent('1@s.whatsapp.net', { text: 'hi' }, 'M1')
  await tick(5)
  sockets[0].close(408)
  const r = await p
  assert.equal(r.outcome, 'unknown')
  assert.match(r.reason, /closed/)
  conn.stop()
})

test('stale connection (no frames) is not usable', async () => {
  let t = 1_000_000
  const { conn } = await connected({}, { now: () => t, staleMs: 45_000 })
  assert.equal(conn.usable(), true)
  t += 60_000
  assert.equal(conn.usable(), false)
  assert.match(conn.whyUnusable(), /stale/)
})

test('not linked: no socket is created', async () => {
  let made = 0
  const conn = createConnection({ authDir: 'x', loadAuth: fakeAuth(false), makeSocket: async () => (made++, fakeSocket()) })
  await conn.connect()
  assert.equal(conn.status().state, 'not_linked')
  assert.equal(made, 0)
})

test('checkExists: phone numbers, mapped LID, known LID, unknown LID', async () => {
  const { conn } = await connected({ missing: ['94779999999@s.whatsapp.net'], lidMap: { '555555555555555@lid': '94776666666:2@s.whatsapp.net' } })
  assert.deepEqual(await conn.checkExists('94771111111@s.whatsapp.net'), { ok: true, phone: '94771111111' })
  assert.equal((await conn.checkExists('94779999999@s.whatsapp.net')).ok, false)
  assert.deepEqual(await conn.checkExists('555555555555555@lid'), { ok: true, phone: '94776666666' })
  assert.deepEqual(await conn.checkExists('123456789012345@lid', { known: true }), { ok: true, phone: null })
  assert.match((await conn.checkExists('123456789012345@lid')).reason, /unknown LID/)
})

test('checkExists times out instead of hanging', async () => {
  const { conn, sockets } = await connected({}, { checkTimeoutMs: 30 })
  sockets[0].onWhatsApp = () => new Promise(() => {})
  assert.match((await conn.checkExists('94771111111@s.whatsapp.net')).reason, /timed out/)
})
