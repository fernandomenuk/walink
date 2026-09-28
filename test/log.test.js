import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(new URL('./fixtures/console-leak.js', import.meta.url))

test('muteConsole: nothing reaches stdout, no key material anywhere, warnings survive as text', () => {
  const r = spawnSync(process.execPath, [FIXTURE], { encoding: 'utf8', env: { ...process.env, WA_LOG: '' } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '', 'stdout is the MCP protocol stream')
  assert.doesNotMatch(r.stderr, /SECRET/)
  const lines = r.stderr.trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.every((l) => l.event === 'console'))
  assert.deepEqual(
    lines.map((l) => [l.level, l.msg.slice(0, 40)]),
    [
      ['warn', 'Session already closed [object]'],
      ['error', 'Session error:Error: Bad MAC'],
      ['error', 'x'.repeat(40)],
      ['warn', 'Session already closed [object]'], // from libsignal itself
    ],
  )
  assert.equal(lines[2].msg.length, 200, 'long messages are cut')
})
