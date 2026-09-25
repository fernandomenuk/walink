# walink

MCP server that lets Claude Code send WhatsApp messages from your personal account through a Baileys linked device. Every send needs your approval in a dialog that the server itself shows you.

## Install

Requires Node 22+.

```sh
npx -y @fernandomenuk/walink login      # scan the QR code: WhatsApp > Settings > Linked devices > Link a device
claude mcp add walink -s user -- npx -y @fernandomenuk/walink
```

Use `@fernandomenuk/walink@next` in both commands to run the preprod channel.

From a clone: `npm install`, `npm run login`, `npm test`, then `claude mcp add walink -s user -- node /path/to/walink/server.js`.

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

## Releasing

Pushing a tag triggers a release. The tag must match the version in `package.json`, and CI (Windows + Linux) must pass before anything is published.

| Channel | Tag | npm dist-tag | GitHub |
| --- | --- | --- | --- |
| preprod | `v2.1.0-rc.1` | `next` | prerelease |
| prod | `v2.1.0` (must be on `main`) | `latest` | release |

```sh
npm version prerelease --preid rc   # 2.1.0-rc.0 -> 2.1.0-rc.1, commits and tags
git push --follow-tags              # publishes to @next

npm version 2.1.0                   # promote: commits and tags v2.1.0
git push --follow-tags              # publishes to @latest
```

One-time setup:
- Add an npm automation token as the `NPM_TOKEN` repository secret: `gh secret set NPM_TOKEN`.
- Optionally, add required reviewers to the `production` environment so a person approves prod publishes.

Re-running a release is safe: versions that are already published are skipped.
