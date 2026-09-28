# walink

MCP server that lets Claude Code send WhatsApp messages from your personal account through a Baileys linked device. Every send needs your approval in a dialog that the server itself shows you.

## Getting started

Works on Windows and Linux, and should work on Mac (not yet tested there).

**Before you start, you need:**
- **Claude Code** installed.
- **Node.js 22 or newer.** Download it from https://nodejs.org. To check, open a terminal and type `node --version`; you should see `v22` or higher.
- Your phone with WhatsApp.

**1. Add walink to Claude Code.** Open Claude Code and type:
```
/plugin marketplace add fernandomenuk/walink
```

**2. Install it:**
```
/plugin install walink@walink
```

**3. Turn on automatic updates:** type `/plugin`, open **Marketplaces**, pick **walink**, and choose **Enable auto-update**.

**4. Link your WhatsApp.** Type:
```
/walink:login
```
Claude gives you a command. Open a **new terminal window**, paste the command, and press Enter. A QR code appears.

**5. Scan the QR code.** On your phone, open WhatsApp > **Settings** > **Linked devices** > **Link a device**, and scan it. Wait until the terminal says **Done**, then close that window.

**6. Try it.** Back in Claude Code, type:
```
send me hi
```
The message arrives in your own WhatsApp chat. Then try a friend: `say hi to @john`. A box shows you the exact message; tick **Send** and confirm. Nothing is ever sent without your OK.

**Good to know**
- Messages to other people end with "🤖 This message is written by Claude".
- walink uses your personal WhatsApp through an unofficial connection (like an extra WhatsApp Web). WhatsApp could restrict accounts that use unofficial clients; use it for normal personal messaging.
- To stop using it: `/plugin uninstall walink@walink`, then on your phone remove the device under **Linked devices**.

<details><summary>For developers</summary>

- Had walink installed the old way? Remove it first so it doesn't run twice: `claude mcp remove walink -s user`. Your link, aliases and groups stay in `~/.whatsapp-mcp`.
- From a clone: `npm install`, `npm test`, `npm run login`, then `/plugin marketplace add /path/to/walink` and `/plugin install walink@walink`.
- Update by hand: `/plugin marketplace update walink`.

</details>

## Use

"tell @nabeel I'm 15 minutes late": Claude calls `whatsapp_send`, and you get a dialog showing the exact recipient and text. Tick **Send** and accept to send it. "send @akka ~/Downloads/report.pdf" works the same way: the file goes as a document, and the dialog shows its name, size and full path. Messages to other people end with "🤖 This message is written by Claude", and the dialog shows it. The reply always starts with one of:

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

Contacts, your aliases and enabled groups are listed as resources, so typing `@` in Claude Code suggests them: `@plugin:walink:wa:wa:akka` (contact), `@plugin:walink:wa:wa:alias/thampalaseteka` (alias), `@plugin:walink:wa:wa:group/test-akka~3e95ad` (group). A new alias or an enabled group tells Claude Code the list changed.

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
claude --dangerously-load-development-channels server:plugin:walink:wa
```

Forwarded messages are never passed on (someone else wrote them), and old messages are never replayed.

## Releasing

Users get a new version only when `version` in `.claude-plugin/plugin.json` changes. Pushes that don't change it reach nobody.

1. Change `version` in `.claude-plugin/plugin.json` (for example `2.0.0` to `2.1.0`).
2. Commit and push to `main`.
