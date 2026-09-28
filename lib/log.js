// Structured JSON logs on stderr (stdout is the MCP protocol). Never log message bodies or auth material.
export function log(level, event, fields = {}) {
  if (process.env.WA_LOG === 'silent') return
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`)
}

// libsignal (under Baileys) prints whole session objects, private keys included, with console.*. Claude Code writes
// a server's stdout and stderr to its log files, and stdout is the MCP stream. So: info-level output is dropped,
// warnings and errors keep their text only (objects become [object]), cut to 200 characters.
// ponytail: blanket console mute; the dependency owns the prints, we own the process.
export function muteConsole() {
  const drop = () => {}
  const keep = (level) => (...args) => log(level, 'console', { msg: args.map((a) => (typeof a === 'string' ? a : '[object]')).join(' ').slice(0, 200) })
  Object.assign(console, { log: drop, info: drop, debug: drop, trace: drop, warn: keep('warn'), error: keep('error') })
}

// 94771234567@s.whatsapp.net -> …4567@s.whatsapp.net
export const maskJid = (jid) => {
  if (typeof jid !== 'string') return jid
  const [user, domain = ''] = jid.split('@')
  return `…${user.slice(-4)}@${domain}`
}
