import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const read = (f) => JSON.parse(readFileSync(join(root, '.claude-plugin', f), 'utf8'))

test('plugin manifest starts a server file that exists', () => {
  const plugin = read('plugin.json')
  const market = read('marketplace.json')
  assert.equal(market.plugins[0].name, plugin.name)
  assert.match(plugin.version, /^\d+\.\d+\.\d+/)
  const [entry] = plugin.mcpServers.walink.args
  assert.ok(existsSync(entry.replace('${CLAUDE_PLUGIN_ROOT}', root)), entry)
})
