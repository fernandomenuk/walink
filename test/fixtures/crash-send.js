// Child process for crash tests: run one real send and die abruptly at the requested point.
//   node crash-send.js <dir> during-approval | in-send | after-send
import { setup } from '../helpers.js'

const [dir, point] = process.argv.slice(2)
const die = () => process.exit(137) // like a kill: no cleanup, no final journal line

const { sender } = await setup({
  dir,
  approve: async () => (point === 'during-approval' ? die() : { ok: true }),
  sock: {
    behavior: () => {
      if (point === 'in-send') die() // inside sendMessage: bytes may or may not have left
      if (point === 'after-send') setImmediate(die) // handed over, before the server ack
      return 'hang'
    },
  },
})
await sender.send({ to: 'Sam', text: 'crash test' })
process.exit(0) // not reached
