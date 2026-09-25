# walink

MCP server that lets Claude Code send WhatsApp messages from your personal account through a Baileys linked device. Every send needs your approval in a dialog that the server itself shows you.

## Setup

```sh
npm install
npm run login        # scan the QR code: WhatsApp > Settings > Linked devices > Link a device
npm test
```

Register it in Claude Code (user scope):

```sh
claude mcp add walink -s user -- node C:\path\to\walink\server.js
```

## Use

"tell @nabeel I'm 15 minutes late": Claude calls `whatsapp_send`, and you get a dialog showing the exact recipient and text. Tick **Send** and accept to send it. The reply always starts with one of:

- `SENT`: WhatsApp's server accepted the message.
- `NOTHING SENT`: nothing left this machine. The reason follows.
- `NOT SENT`: WhatsApp rejected the message.
- `OUTCOME UNKNOWN`: the message may have gone out. Check WhatsApp before retrying.

| Tool | Purpose |
| --- | --- |
| `whatsapp_send` | Send text (`to`, `text`, optional `resend_of` after an unknown outcome) |
| `whatsapp_status` | Connection, session owner, approval support, unknown outcomes |
| `whatsapp_find_contact` | Look up a name, alias or number |
| `whatsapp_set_alias` | Remember `@name` → contact (`replace: true` to repoint) |

Contacts are also listed as `@walink:wa://name` resources.

See [docs/DESIGN.md](docs/DESIGN.md) for the state machines, failure semantics, recovery and security model.
