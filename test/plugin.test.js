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
  const [entry] = plugin.mcpServers.wa.args
  assert.ok(existsSync(entry.replace('${CLAUDE_PLUGIN_ROOT}', root)), entry)
})

test('plugin hooks call walink\'s own whatsapp_hook tool', () => {
  const { hooks } = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'))
  const tools = readFileSync(join(root, 'lib', 'tools.js'), 'utf8')
  const all = Object.values(hooks).flat().flatMap((m) => m.hooks)
  assert.ok(all.length >= 3)
  for (const h of all) {
    assert.equal(h.type, 'mcp_tool')
    assert.equal(h.server, 'plugin:walink:wa')
    assert.ok(tools.includes(`'${h.tool}'`), h.tool)
  }
})
