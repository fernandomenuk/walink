// Human approval through MCP elicitation: the MCP client shows the user a dialog that the model cannot
// answer. This is the security boundary for sending; nothing the model says can substitute for it.
import { describe, norm, sanitize } from './contacts.js'
import { formatBytes } from './file.js'
import { describeGroup, groupKey } from './groups.js'

// text: the message, or a file's caption (null = none). file: a loadFile() result, sent as a document.
// group: a group record (instead of contact); confirmName: the name the user must type (groups above 50 members).
export function buildPreview({ contact, group = null, via, text, file = null, warnings = [], connection, takeover = null, confirmName = null }) {
  const rule = '────────────────────'
  const note = takeover === null ? '' : ` This moves WhatsApp here from the other Claude Code session (pid ${takeover}).`
  const textBlock = (t) => {
    const lines = t.split('\n').length
    return [rule, t, rule, `(${[...t].length} characters, ${lines} line${lines === 1 ? '' : 's'}, exactly as it will be sent)`]
  }
  // File names and paths are shown cleaned (no control or bidi characters), and flagged if cleaning changed them.
  const shown = file && { name: sanitize(file.name, 200), path: sanitize(file.realPath, 1000) }
  const hidden = file && (shown.name !== file.name || shown.path !== file.realPath)
  // A group says so first, loudly: name, member count, and that everyone in it will see this.
  const target = group
    ? `WhatsApp ${describeGroup(group)}`
    : describe(contact)
  const everyone = group ? ['Everyone in the group will see this.'] : []
  // Recipient and content come first: Claude Code collapses the dialog to its first few lines.
  const head = file
    ? [
        `${group ? '⚠ ' : ''}Send this ${group ? '' : 'WhatsApp '}file to ${target}?${note}`,
        ...everyone,
        `File: ${shown.name} (${formatBytes(file.size)}, sent as a document)`,
        `Path: ${shown.path}`,
        ...(text === null ? ['Caption: (none)'] : ['Caption:', ...textBlock(text)]),
      ]
    : [`${group ? '⚠ Send this message to ' : 'Send this WhatsApp message to '}${target}?${note}`, ...everyone, ...textBlock(text)]
  return [
    ...head,
    ...(hidden ? ['⚠ The file name or path contains hidden or control characters; they are shown as spaces.'] : []),
    ...warnings.map((w) => `⚠ ${w}`),
    `Matched by: ${via}`,
    ...(group ? [`Group: group:${groupKey(group)}${group.ephemeralDuration ? ` · disappearing messages on (${Math.round(group.ephemeralDuration / 86400)} days)` : ''}`] : []),
    `WhatsApp: ${connection}`,
    '',
    confirmName
      ? 'Type the group name exactly as shown above, tick "Send" and accept to send it. Anything else sends nothing.'
      : 'Tick "Send" and accept to send it. Anything else sends nothing.',
  ].join('\n')
}

// Returns an approver: async (preview, { confirmName?, checkbox?, what? }) =>
//   { ok: true } | { ok: false, state: 'declined'|'expired'|'unsupported', reason }
// confirmName: the user must also type this name (compared case- and width-insensitively).
export function elicitationApprover(mcpServer, { timeoutMs = 120_000 } = {}) {
  return async (preview, { confirmName = null, checkbox = 'Send', what = 'Send this exact message to this recipient' } = {}) => {
    if (!mcpServer.server.getClientCapabilities()?.elicitation) {
      return { ok: false, state: 'unsupported', reason: 'this MCP client cannot show approval dialogs (elicitation), so sending is disabled' }
    }
    try {
      const r = await mcpServer.server.elicitInput(
        {
          message: preview,
          requestedSchema: {
            type: 'object',
            properties: {
              send: { type: 'boolean', title: checkbox, description: what, default: false },
              ...(confirmName && { confirm_name: { type: 'string', title: 'Group name', description: 'Type the group name shown above' } }),
            },
            required: confirmName ? ['send', 'confirm_name'] : ['send'],
          },
        },
        { timeout: timeoutMs },
      )
      if (r.action !== 'accept') return { ok: false, state: 'declined', reason: `the approval dialog was ${r.action === 'cancel' ? 'cancelled' : 'declined'}` }
      if (r.content?.send !== true) return { ok: false, state: 'declined', reason: `"${checkbox}" was not ticked` }
      if (confirmName && norm(r.content?.confirm_name) !== norm(confirmName)) {
        return { ok: false, state: 'declined', reason: `the typed group name did not match "${confirmName}"` }
      }
      return { ok: true }
    } catch (e) {
      const unsupported = /does not support/i.test(e.message)
      return { ok: false, state: unsupported ? 'unsupported' : 'expired', reason: `approval did not complete: ${e.message}` }
    }
  }
}
