// Child process for log tests: mute the console, then print the way libsignal does (and through libsignal itself).
import { createRequire } from 'node:module'
import { muteConsole } from '../../lib/log.js'

muteConsole()
const secret = { privKey: 'SECRET-PRIV', rootKey: 'SECRET-ROOT', indexInfo: { closed: -1 } }
console.info('Closing session:', secret)
console.log('Opening session:', secret)
console.debug(secret)
console.trace('trace', secret)
console.warn('Session already closed', secret)
console.error(`Session error:${new Error('Bad MAC')}`)
console.error('x'.repeat(500))

// The real leak path: libsignal's SessionRecord.closeSession prints the whole session.
const { SessionRecord } = createRequire(import.meta.url)('libsignal')
const record = new SessionRecord()
record.closeSession({ ...secret, indexInfo: { closed: -1 } })
record.closeSession({ ...secret, indexInfo: { closed: 1 } }) // "already closed": console.warn with the session
