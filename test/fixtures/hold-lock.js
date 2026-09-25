// Child process for lock tests: take the lock, report, then idle until killed.
import { acquireLock, startHeartbeat } from '../../lib/lock.js'

const file = process.argv[2]
if (!acquireLock(file).owner) process.exit(2)
startHeartbeat(file)
process.send('locked')
setInterval(() => {}, 1000)
