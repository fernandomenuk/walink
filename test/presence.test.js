import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { channelsFlag, createPresence, detectChannels, shouldReclaim } from '../lib/presence.js'
import { tick, tmp } from './helpers.js'

test('channelsFlag: finds walink in either channels flag, in every spelling Claude Code accepts', () => {
  const yes = [
    '"C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" --dangerously-load-development-channels plugin:walink@walink',
    'claude --dangerously-load-development-channels server:walink',
    'claude --channels plugin:walink@walink --model opus',
    'claude --channels=plugin:walink@walink',
    'claude --channels plugin:telegram@x,plugin:walink@walink',
    'claude --channels plugin:telegram@x plugin:walink@walink',
    ['node', '/usr/lib/claude/cli.js', '--dangerously-load-development-channels', 'plugin:walink@walink'], // /proc cmdline
  ]
  for (const c of yes) assert.equal(channelsFlag(c), true, String(c))
  const no = [
    '"C:\\Program Files\\claude.exe"',
    'claude --channels plugin:telegram@x',
    'claude --channels plugin:telegram@x --add-dir walink', // walink after the flag's values ended
    'claude --resume walink',
    '',
    undefined,
  ]
  for (const c of no) assert.equal(channelsFlag(c), false, String(c))
})

test('detectChannels: WALINK_CHANNELS overrides; a lookup that fails or finds nothing is unknown (null)', async () => {
  const read = (cmd) => async () => cmd
  assert.equal(await detectChannels({ env: { WALINK_CHANNELS: '1' }, readCmdline: read('claude') }), true)
  assert.equal(await detectChannels({ env: { WALINK_CHANNELS: '0' }, readCmdline: read('claude --channels plugin:walink@walink') }), false)
  assert.equal(await detectChannels({ env: {}, readCmdline: read('claude --channels plugin:walink@walink') }), true)
  assert.equal(await detectChannels({ env: {}, readCmdline: read('claude') }), false)
  assert.equal(await detectChannels({ env: {}, readCmdline: read('') }), null)
  assert.equal(await detectChannels({ env: {}, readCmdline: async () => { throw new Error('timeout') } }), null)
})

test('detectChannels: the real lookup of this process parent runs without throwing', async () => {
  const r = await detectChannels({ env: {} })
  assert.ok(r === false || r === null, `the test runner is not started with channels, got ${r}`)
})

test('registry: register, list, unregister', () => {
  const dir = tmp()
  const a = createPresence(dir, { pid: process.pid })
  a.register({ label: 'proj', channels: true })
  const [s] = a.list()
  assert.equal(s.pid, process.pid)
  assert.equal(s.label, 'proj')
  assert.equal(s.channels, true)
  a.unregister()
  assert.deepEqual(a.list(), [])
})

test('registry: dead pids and stopped heartbeats are dropped and deleted; corrupt files are skipped', () => {
  const dir = tmp()
  const p = createPresence(dir)
  const sessions = join(dir, 'sessions')
  writeFileSync(join(sessions, '999999.json'), JSON.stringify({ pid: 999999, channels: true })) // no such process
  writeFileSync(join(sessions, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, channels: true })) // live pid, old file
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(join(sessions, `${process.ppid}.json`), old, old)
  writeFileSync(join(sessions, '12345.json'), '{not json')
  assert.deepEqual(p.list(), [])
  assert.ok(!existsSync(join(sessions, '999999.json')))
  assert.ok(!existsSync(join(sessions, `${process.ppid}.json`)), 'pid reuse after a reboot must not look alive')
  assert.ok(readdirSync(sessions).includes('12345.json'), 'a corrupt file is left alone, never trusted')
})

test('shouldReclaim: only a listening session, only from an owner that is not listening', () => {
  const sessions = [
    { pid: 10, channels: true },
    { pid: 20, channels: false },
    { pid: 30, channels: null },
  ]
  const r = (listening, holderPid) => shouldReclaim({ listening, holderPid, sessions, pid: 1 })
  assert.equal(r(true, 20), true, 'owner without channels')
  assert.equal(r(true, 30), true, 'owner that could not tell')
  assert.equal(r(true, 40), true, 'owner from an older walink with no registry entry')
  assert.equal(r(true, 10), false, 'never steal from another listening session (no ping-pong)')
  assert.equal(r(false, 20), false)
  assert.equal(r(null, 20), false)
  assert.equal(r(true, null), false, 'nobody owns it: the normal lock poll takes it')
  assert.equal(shouldReclaim({ listening: true, holderPid: 1, sessions, pid: 1 }), false, 'already ours')
})

test('server: registers this session with its channels state, and removes it when Claude Code closes it', async () => {
  const dir = tmp() // not linked: the server never touches WhatsApp
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, WHATSAPP_MCP_DIR: dir, WALINK_CHANNELS: '1', WA_LOG: 'silent' },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const file = join(dir, 'sessions', `${server.pid}.json`)
  for (let i = 0; i < 100 && !existsSync(file); i++) await tick(100)
  const p = createPresence(dir)
  assert.deepEqual(p.list().map((s) => [s.pid, s.channels]), [[server.pid, true]])
  server.stdin.end() // Claude Code closing the session
  await new Promise((r) => server.once('exit', r))
  assert.ok(!existsSync(file))
})
