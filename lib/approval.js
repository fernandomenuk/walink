// Human approval through MCP elicitation: the MCP client shows the user a dialog that the model cannot
// answer. This is the security boundary for sending; nothing the model says can substitute for it.
import { describe } from './contacts.js'

export function buildPreview({ contact, via, text, warnings = [], connection, takeover = null }) {
  const lines = text.split('\n').length
  const rule = '────────────────────'
  // Recipient and text come first: Claude Code collapses the dialog to its first few lines.
  return [
    `Send this WhatsApp message to ${describe(contact)}?${takeover === null ? '' : ` This moves WhatsApp here from the other Claude Code session (pid ${takeover}).`}`,
    rule,
    text,
    rule,
    `(${[...text].length} characters, ${lines} line${lines === 1 ? '' : 's'}, exactly as it will be sent)`,
    ...warnings.map((w) => `⚠ ${w}`),
    `Matched by: ${via}`,
    `WhatsApp: ${connection}`,
    '',
    'Tick "Send" and accept to send it. Anything else sends nothing.',
  ].join('\n')
}

// Returns an approver: async (preview) => { ok: true } | { ok: false, state: 'declined'|'expired'|'unsupported', reason }
export function elicitationApprover(mcpServer, { timeoutMs = 120_000 } = {}) {
  return async (preview) => {
    if (!mcpServer.server.getClientCapabilities()?.elicitation) {
      return { ok: false, state: 'unsupported', reason: 'this MCP client cannot show approval dialogs (elicitation), so sending is disabled' }
    }
    try {
      const r = await mcpServer.server.elicitInput(
        {
          message: preview,
          requestedSchema: {
            type: 'object',
            properties: { send: { type: 'boolean', title: 'Send', description: 'Send this exact message to this recipient', default: false } },
            required: ['send'],
          },
        },
        { timeout: timeoutMs },
      )
      if (r.action === 'accept' && r.content?.send === true) return { ok: true }
      return { ok: false, state: 'declined', reason: r.action === 'accept' ? '"Send" was not ticked' : `the approval dialog was ${r.action === 'cancel' ? 'cancelled' : 'declined'}` }
    } catch (e) {
      const unsupported = /does not support/i.test(e.message)
      return { ok: false, state: unsupported ? 'unsupported' : 'expired', reason: `approval did not complete: ${e.message}` }
    }
  }
}
