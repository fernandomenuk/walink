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

"tell @nabeel I'm 15 minutes late": Claude calls `whatsapp_send`, and you get a dialog showing the exact recipient and text. Tick **Send** and accept to send it. "send @akka ~/Downloads/report.pdf" works the same way: the file goes as a document, and the dialog shows its name, size and full path. Messages to other people end with a short line saying an AI typed them (for example "— sent by my AI 🤖"), and the dialog shows it. The reply always starts with one of:

- `SENT`: WhatsApp's server accepted the message.
- `NOTHING SENT`: nothing left this machine. The reason follows.
- `NOT SENT`: WhatsApp rejected the message.
- `OUTCOME UNKNOWN`: the message may have gone out. Check WhatsApp before retrying.

| Tool | Purpose |
| --- | --- |
| `whatsapp_send` | Send text, or a file as a document (`to`, `text`, optional `file` absolute path up to 100 MB, optional `resend_of` after an unknown outcome) |
| `whatsapp_status` | Connection, session owner, approval support, unknown outcomes |
| `whatsapp_find` (also `whatsapp_find_contact`) | Look up a contact (name, alias, number) or a group (name). Groups come back with their `group:<key>` reference |
| `whatsapp_groups` | List your groups, enabled ones first |
| `whatsapp_group_enable` / `whatsapp_group_disable` | Allow or stop sends to a group. Enabling shows you a dialog; Claude can't do it alone |
| `whatsapp_notify_me` | Notify you in your own chat (no dialog) |
| `whatsapp_ask_me` | Ask you in your own chat and wait for the reply (`question`, `options`, `wait_minutes`, `wait_for`) |
| `whatsapp_set_alias` | Remember `@name` → a contact, or a group (`to: "group:<key>"`). `replace: true` repoints |

Contacts are also listed as `@walink:wa://name` resources.

See [docs/DESIGN.md](docs/DESIGN.md) for the state machines, failure semantics, recovery and security model.

## Groups

Groups are opt-in and stricter than people:

1. **Enable a group once.** Ask Claude to "enable the HushChat Team group": it finds the group and asks you in a dialog ("Allow Claude to send to WhatsApp GROUP …?"). Claude cannot enable a group by itself.
2. **Name it explicitly.** Claude sends to a group only by its reference (`group:hushchat-team~3fa9c1`, from `whatsapp_find` / `whatsapp_groups`) or an alias you set ("@hushchat"). A plain name never picks a group, and raw `…@g.us` IDs are refused.
3. **Every send shows a GROUP dialog:** `⚠ Send this message to WhatsApp GROUP "HushChat Team" · 14 members?` and "Everyone in the group will see this." For groups over 50 members you also type the group's name.

Before each group send walink looks the group up live: it refuses if you left, the group is gone, only admins can post and you aren't one, or it's a community (post in its announcements group). Files go to groups the same way as to people ("send the latest APK to @hushchat"): Claude finds the file, the dialog shows its name, size and path.

## Phone channel

Claude can reach you on your phone, in your own WhatsApp chat, without an approval dialog:

- "Run the tests and ping me on WhatsApp when done": `whatsapp_notify_me` sends `🤖 <project>` and the result.
- "Ask me on WhatsApp before you drop that column": `whatsapp_ask_me` posts the question with numbered options. Reply with a number or your own words (swipe-reply if several questions are open). walink reacts ✅ when your answer reached Claude.
- From your phone, start a message with `@claude` ("@claude what's the git status?"). walink reacts 👀 and passes it to the session. Other messages in your own chat stay private.

Replies that arrive after Claude stopped waiting, and `@claude` messages, need Claude Code started with channels enabled (a research preview):

```sh
claude --dangerously-load-development-channels server:walink
```

Forwarded messages are never passed on (someone else wrote them), and old messages are never replayed.

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
