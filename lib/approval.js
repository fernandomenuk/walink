// Human approval through MCP elicitation: the MCP client shows the user a dialog that the model cannot
// answer. This is the security boundary for sending; nothing the model says can substitute for it.
import { describe, sanitize } from './contacts.js'
import { formatBytes } from './file.js'

// text: the message, or a file's caption (null = none). file: a loadFile() result, sent as a document.
export function buildPreview({ contact, via, text, file = null, warnings = [], connection, takeover = null }) {
  const rule = '────────────────────'
  const note = takeover === null ? '' : ` This moves WhatsApp here from the other Claude Code session (pid ${takeover}).`
  const textBlock = (t) => {
    const lines = t.split('\n').length
    return [rule, t, rule, `(${[...t].length} characters, ${lines} line${lines === 1 ? '' : 's'}, exactly as it will be sent)`]
  }
  // File names and paths are shown cleaned (no control or bidi characters), and flagged if cleaning changed them.
  const shown = file && { name: sanitize(file.name, 200), path: sanitize(file.realPath, 1000) }
  const hidden = file && (shown.name !== file.name || shown.path !== file.realPath)
  // Recipient and content come first: Claude Code collapses the dialog to its first few lines.
  const head = file
    ? [
        `Send this WhatsApp file to ${describe(contact)}?${note}`,
        `File: ${shown.name} (${formatBytes(file.size)}, sent as a document)`,
        `Path: ${shown.path}`,
        ...(text === null ? ['Caption: (none)'] : ['Caption:', ...textBlock(text)]),
      ]
    : [`Send this WhatsApp message to ${describe(contact)}?${note}`, ...textBlock(text)]
  return [
    ...head,
    ...(hidden ? ['⚠ The file name or path contains hidden or control characters; they are shown as spaces.'] : []),
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
