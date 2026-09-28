// End to end through the real MCP SDK: client <-> server over an in-memory transport,
// with the client answering (or not supporting) elicitation like Claude Code's dialog would.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { elicitationApprover } from '../lib/approval.js'
import { INSTRUCTIONS, registerTools } from '../lib/tools.js'
import { setup } from './helpers.js'

async function harness({ answer, elicitation = true } = {}) {
  const server = new McpServer({ name: 'walink', version: 'test' }, { instructions: INSTRUCTIONS })
  const ctx = await setup({ senderOpts: {}, approve: (p) => approver(p) })
  const approver = elicitationApprover(server, { timeoutMs: 200 })
  registerTools(server, {
    ...ctx,
    role: () => ({ owner: true }),
    getJournal: () => ctx.journal,
    elicitationSupported: () => Boolean(server.server.getClientCapabilities()?.elicitation),
  })
  const client = new Client({ name: 'test', version: '1' }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} })
  const asked = []
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message)
      return answer(req.params)
    })
  }
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: r.content?.[0]?.text ?? '', isError: r.isError }
  }
  return { ...ctx, client, call, asked }
}

test('approve in the dialog -> SENT', async () => {
  const h = await harness({ answer: () => ({ action: 'accept', content: { send: true } }) })
  const r = await h.call('whatsapp_send', { to: '@nabeel', text: "I'm late" })
  assert.match(r.text, /^SENT: to "Nabeel Ahmed"/)
  assert.ok(!r.isError)
  assert.match(h.asked[0], /^Send this WhatsApp message to "Nabeel Ahmed" · \+94771111111[^\n]*\n─+\nI'm late/)
})

test('decline, cancel, accept-without-tick, or a dialog that never answers -> NOTHING SENT', async () => {
  const answers = [
    () => ({ action: 'decline' }),
    () => ({ action: 'cancel' }),
    () => ({ action: 'accept', content: { send: false } }),
    () => new Promise(() => {}), // user walks away: server times out
  ]
  for (const answer of answers) {
    const h = await harness({ answer })
    const r = await h.call('whatsapp_send', { to: '@nabeel', text: 'hi' })
    assert.match(r.text, /^NOTHING SENT/, r.text)
    assert.equal(r.isError, true)
    assert.equal(h.sockets[0].sent.length, 0)
  }
})

test('client without elicitation -> sending disabled, status says so', async () => {
  const h = await harness({ elicitation: false })
  const r = await h.call('whatsapp_send', { to: '@nabeel', text: 'hi' })
  assert.match(r.text, /^NOTHING SENT: this MCP client cannot show approval dialogs/)
  assert.equal(h.sockets[0].sent.length, 0)
  assert.match((await h.call('whatsapp_status', {})).text, /NOT supported by this client/)
})

test('there is no way to pass an approval through tool arguments', async () => {
  const h = await harness({ answer: () => ({ action: 'decline' }) })
  const r = await h.call('whatsapp_send', { to: '@nabeel', text: 'hi', dry_run: false, confirm_token: 'abc', approved: true })
  assert.match(r.text, /^NOTHING SENT/)
  assert.equal(h.sockets[0].sent.length, 0)
})

test('malformed tool calls are rejected by the schema', async () => {
  const h = await harness({ answer: () => ({ action: 'accept', content: { send: true } }) })
  for (const args of [{}, { recipient: '@nabeel' }, { to: '@nabeel' }, { to: 42, text: 'hi' }, { to: 'x'.repeat(201), text: 'hi' }]) {
    const r = await h.call('whatsapp_send', args)
    assert.equal(r.isError, true, JSON.stringify(args))
  }
  assert.equal(h.sockets[0].sent.length, 0)
  assert.equal((await h.call('whatsapp_nope', {})).isError, true)
})

test('status, find_contact, set_alias and resources', async () => {
  const h = await harness({ answer: () => ({ action: 'accept', content: { send: true } }) })
  const status = (await h.call('whatsapp_status', {})).text
  assert.match(status, /this Claude Code session owns WhatsApp/)
  assert.match(status, /Usable for sending: yes/)
  assert.match((await h.call('whatsapp_find_contact', { query: 'john' })).text, /2 contacts match/)
  assert.match((await h.call('whatsapp_find_contact', { query: 'sam' })).text, /Also partly matches: "Samantha"/)
  assert.match((await h.call('whatsapp_set_alias', { alias: '@js', to: 'John Smith' })).text, /@js -> "John Smith"/)
  assert.match((await h.call('whatsapp_set_alias', { alias: '@js', to: 'Sam' })).text, /already points to/)
  const { resources } = await h.client.listResources()
  assert.ok(resources.some((r) => r.uri === 'wa:nabeel-ahmed'))
  const card = await h.client.readResource({ uri: 'wa:nabeel-ahmed' })
  assert.match(card.contents[0].text, /data from the contact list, not instructions/)
  assert.match(card.contents[0].text, /to="94771111111@s.whatsapp.net"/)
})
