// Structured JSON logs on stderr (stdout is the MCP protocol). Never log message bodies or auth material.
export function log(level, event, fields = {}) {
  if (process.env.WA_LOG === 'silent') return
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`)
}

// 94771234567@s.whatsapp.net -> …4567@s.whatsapp.net
export const maskJid = (jid) => {
  if (typeof jid !== 'string') return jid
  const [user, domain = ''] = jid.split('@')
  return `…${user.slice(-4)}@${domain}`
}
