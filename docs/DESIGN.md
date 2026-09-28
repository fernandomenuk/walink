# walink — design, failure semantics, security

One rule outranks everything else: **never send to the wrong person, never send twice by accident, and never say "sent" unless it is known.**

## Modules

| File | Job |
| --- | --- |
| `server.js` | Wiring, session ownership, `login` mode, shutdown |
| `lib/connection.js` | Baileys socket state machine, reconnect policy, server-ack tracking, existence checks |
| `lib/groups.js` | Group store (metadata only), sync from events and full fetches, group keys, `resolveTarget` |
| `lib/contacts.js` | Contact/alias store, conservative resolver, phone/Unicode normalization, JID allowlist, resource keys |
| `lib/approval.js` | Approval preview text + MCP elicitation (the human-approval boundary) |
| `lib/sender.js` | One send end to end, serial queue, rate limit |
| `lib/phone.js` | Phone channel: questions, reply matching, inbound filter, channel pushes |
| `lib/file.js` | Reads a file to send (once), size limit, MIME type, secret-path warnings |
| `lib/journal.js` | Append-only `sends.jsonl`, crash recovery, duplicate lookups |
| `lib/lock.js` | Single owner of `auth/` across processes |
| `lib/persist.js` | Atomic JSON writes, quarantine of corrupt files, fsync'd JSONL |
| `lib/tools.js` | MCP tools, resources, instructions |
| `lib/log.js` | JSON logs on stderr, masked JIDs, no message bodies |

Data lives in `~/.whatsapp-mcp/` (override: `WHATSAPP_MCP_DIR`): `auth/`, `auth.lock`, `contacts.json`, `aliases.json`, `sends.jsonl`.

## Send lifecycle

```mermaid
stateDiagram-v2
    [*] --> rejected: invalid text / recipient / not owner / not connected / not on WhatsApp / uncertain duplicate
    [*] --> pending: validated, approval dialog shown
    pending --> declined: user declines, cancels, or doesn't tick Send
    pending --> expired: no answer in 120s / client can't elicit / crash
    pending --> rejected: approved, but connection or ownership lost before sending
    pending --> sending: approved; journaled (fsync) BEFORE the socket is touched
    sending --> sent: WhatsApp server ack
    sending --> failed: server ack with error (e.g. 463)
    sending --> unknown: no ack in 20s / connection closed / send error / process crash
```

Each `whatsapp_send` call is one request with a fresh `reqId`, and each attempt gets its own Baileys message id (`msgId`). The journal records both before sending.

## Failure semantics

| What happened | Result | Did it reach WhatsApp? | Safe to retry? |
| --- | --- | --- | --- |
| Validation, ambiguity, not owner, not connected, not on WhatsApp | `NOTHING SENT` | No | Yes, after fixing the cause |
| Approval declined / cancelled / timed out / unsupported | `NOTHING SENT` | No | Yes |
| Connection lost between approval and send | `NOTHING SENT` | No | Yes |
| Server ack received | `SENT` | Yes, WhatsApp's server accepted it. Delivery/read are not tracked | Only as a new, intentional message |
| Error ack (e.g. 463 account restricted) | `NOT SENT` | Rejected by WhatsApp | Usually not; fix the cause |
| No ack in 20s, socket closed, send threw, process crashed after `sending` | `OUTCOME UNKNOWN` | Maybe | **Only after the user checks WhatsApp**, via `resend_of` |

**Duplicate rules:**
- Same recipient + same text while an earlier attempt is `sending`/`unknown` (within 24h, not yet resolved) → refused, unless `resend_of` names that attempt. The approval dialog then says RESEND.
- Same recipient + same text already `sent` in the last 10 minutes → allowed, but the dialog warns. Repeats are allowed, but only on purpose.
- Identical concurrent requests each need their own human approval.

## Connection states

```mermaid
stateDiagram-v2
    [*] --> not_linked: no creds
    [*] --> connecting
    connecting --> connected: open
    connected --> reconnecting: close 408/428/503/other (backoff 1s→60s ±20%)
    connected --> reconnecting: close 515 (immediate)
    reconnecting --> connected: open
    connected --> logged_out: 401
    connected --> forbidden: 403
    connected --> bad_session: 500
    connected --> conflict: 440
```

- `logged_out`, `forbidden`, `bad_session` and `conflict` are terminal: no reconnect loop.
- Reconnects are single-flight. Events from replaced sockets are ignored.
- The connection only counts as usable if WhatsApp sent data within the last 45s. Keepalives arrive every 30s, so a silently dead link (for example after sleep) is refused rather than trusted.

## One owner per linked device

- Every Claude Code session starts its own `server.js`.
- The first one to create `auth.lock` (O_EXCL) owns the WhatsApp socket and touches the lock every 5s. The others are **followers**: lookups and status work. A send from a follower shows one approval dialog that also says it moves WhatsApp to this session.
- A lock is stale when its pid is gone or its heartbeat is older than 30s. That covers Windows pid reuse after a reboot.
- **Handover on approval:** when the user approves a follower's send, the follower writes `auth.lock.handover` (`{pid, ts}`). The owner checks for it every second, stops accepting sends (queued ones return `NOTHING SENT`), waits for in-flight sends to finish so the handover never creates an `OUTCOME UNKNOWN`, closes its socket, releases the lock and becomes a follower. The requester takes the lock, connects, runs the existence and duplicate checks it skipped, and sends without a second dialog. It gives up after 30s (hung owner, or another session won the race) with `NOTHING SENT`, and always removes its request file. Requests from dead pids are ignored.
- Followers poll every 10s and take over automatically when the owner dies (not while another live session's handover request is pending). On takeover a follower reloads contacts and aliases, then runs journal recovery.
- The server exits when stdin closes, so an orphan can't keep holding the session.

## Files

- `whatsapp_send` takes an optional `file` (an absolute path). The file goes as a WhatsApp **document**, never recompressed, and `text` becomes an optional caption.
- **Refused before the dialog:** a relative path, a missing file, a folder, an empty file, or anything over 100 MB. Symlinks are resolved and the real target is what gets sent.
- **Read once, before the dialog.** The bytes are held in memory and fingerprinted (SHA-256). Those bytes are what is sent, so changing the file on disk after approval changes nothing.
- **The dialog** opens with the recipient, the file name and size, and the full real path, then the caption. It warns (⚠) about secret-looking paths (`.ssh`, `.aws`, `.env*`, `*.pem`, `id_*`, `credentials*`, `~/.whatsapp-mcp`, and similar), links, files outside the home folder, and names containing control or bidi characters. Any file can be sent: the user is the gate.
- **Journal:** the `pending` line records `file: { name, size, sha256 }`, never the path or the contents. The duplicate and unknown-outcome guards key on the caption plus the file's fingerprint, so a blind resend of the same file after `OUTCOME UNKNOWN` is refused like text.
- `SENT` still means the server ack for the message. The upload runs before the message is relayed, so an upload failure (or a crash during it) is a certain `NOT SENT` and a retry is allowed; errors after the relay starts are `OUTCOME UNKNOWN` (see "Media: upload, then relay").

## Phone channel

Your own WhatsApp chat is a two-way line to the Claude Code session that owns WhatsApp.

- **Out, with no dialog:** sends to your own chat (`me`, `whatsapp_notify_me`, `whatsapp_ask_me`) skip the approval dialog and the duplicate guards, because they can only reach you. Sends to anyone else are unchanged.
- **Questions:** `whatsapp_ask_me` posts the question (with numbered options) and waits up to 25 minutes per call, under Claude Code's 30-minute idle timeout for stdio tools.
  - It returns `REPLY`, `NO REPLY YET` (the question stays open for 24h), or `CANCELLED` (Esc: the question is closed and edited on WhatsApp).
  - A swipe-reply names its question. Otherwise the newest open question of this session gets the answer. A bare number picks that option.
  - A late answer is pushed into the session and kept in memory for `wait_for`.
- **In:** replies to questions, and messages that start with `@claude`, are pushed as `notifications/claude/channel` (capability `experimental['claude/channel']`). Everything else you type in your own chat stays private. This needs Claude Code started with `--dangerously-load-development-channels server:plugin:walink:wa` while channels are a research preview; without it, questions still work through the waiting call.
- **What counts as input:** a message in your own chat (phone-number JID or LID), `fromMe`, delivered live (`notify`, not history sync), not a message walink sent (its ids are in the journal and in memory), not forwarded (someone else wrote it; walink reacts ⚠️), and not older than the question or than this session's ownership (2 minutes of clock skew allowed). Duplicates, edits, reactions and deletes are ignored.
- **Acknowledgements:** walink reacts ✅ to an answer it delivered and 👀 to an `@claude` message it pushed. A swipe-reply to a closed question, or to another live session's question, gets a short notice instead.
- **Journal:** questions are records (`Q1`, `Q2`, …) with the question's message id, owner pid and label, and expiry. Answers record the reply's id and length, never its text.
- **Sessions:** only the owner has the socket, so only the owner receives. A follower's notification or question takes over with a *soft* request; the owner declines it while one of its questions is being waited on, and the follower gets `NOTHING SENT` with the reason. A dialog-approved send (a *hard* request) always proceeds and ends the old owner's waits with a clear reason.

## Groups

Full design: `docs/specs/2026-09-25-groups-design.md`.

- **Identity:** a group's ID (`…@g.us`) never changes; names do. walink keys everything on the ID. A group key is `<name-slug>~<6 hex of sha256(ID)>`, and only the hash is matched, so a key from before a rename still reaches the same group and can never reach another.
- **Sync:** a full `groupFetchAllParticipating` on every owner connect (known groups missing from it become `left`), plus `groups.update` (renames, settings) and `group-participants.update` (our own removal is detected against both our phone-number ID and LID; Baileys' own check misses PN groups). A deleted group emits nothing, so the live lookup before each send is the real check.
- **Enabled state** lives in `groups.json`, written read-modify-write so two sessions don't overwrite each other; reads pick up the other session's writes by file mtime.

### Media: upload, then relay

A document is built and uploaded first (`generateWAMessage`), and only then relayed. The journal records `uploading` before the upload and `sending` before the relay:

```
uploading --upload error or crash--> failed      certain: no message was sent; retrying is allowed
    |
sending   --ack--> sent | --error ack--> failed | --timeout/close/crash--> unknown
```

## Recovery

- **Crash or restart mid-send:**
  - On load, the journal turns `sending` into `unknown` and `pending` into `expired`. The recovery lines are themselves journaled.
  - `whatsapp_status` lists unresolved unknowns with their time.
  - The user checks WhatsApp and then either leaves the entry alone (it drops out of the guard after 24h) or asks to resend (`resend_of`).
- **Corrupt `contacts.json` or `aliases.json`:** the file is renamed to `*.corrupt-<ts>`, the server starts with an empty store, and `status` names the file. Contacts come back with `/walink:login`. Aliases can be restored by hand from the quarantined file.
- **Torn journal line:** it is skipped on load, and the next append starts on a new line.
- **Terminal states:**
  - `logged_out` / `bad_session`: run `/walink:login`, which wipes the dead credentials and shows a QR code.
  - `conflict`: close the other client, then reconnect the MCP (`/mcp`).
  - `forbidden`: the account is restricted, so there is nothing to automate.

## Security model

- **Recipients know Claude wrote it.** Every message (or file caption) to someone else ends with one fixed line, `🤖 This message is written by Claude` (`SIGNATURE` in `lib/sender.js`). The dialog shows it, a resend is byte-identical, and the duplicate guards hash the text without it. Messages to your own chat carry the `🤖 walink · <folder>` header instead.

- **Approval is enforced by the server.** Every send shows an MCP elicitation dialog built by the server, containing:
  - the recipient's name, phone and chat ID;
  - the exact text, with character and line counts;
  - any warnings.

  Only `accept` with **Send** ticked sends. The model can't answer this dialog, and no tool argument can bypass it. A client without elicitation can't send at all.
- **Recipients** are 1:1 chats (`<digits>@s.whatsapp.net` or `<digits>@lid`) or **enabled groups reached by an explicit reference** (`group:<key>` or an alias). Raw `@g.us`, broadcasts, newsletters and other domains are refused, including through aliases and raw IDs. A plain name never resolves to a group.
- **Groups are opt-in.** Only `whatsapp_group_enable`, through a dialog the model cannot answer, makes a group sendable. Each group send re-fetches the group live (membership, admin-only, community), shows a GROUP dialog with the name, member count and "everyone will see this", and above 50 members requires typing the name. The send uses exactly the metadata shown (Baileys `cachedGroupMetadata`). `groups.json` stores metadata only, never member lists.
  - Phone numbers are checked with `onWhatsApp`.
  - A LID is mapped to its phone number when possible and then checked. Otherwise it must come from WhatsApp's own contact sync, and the dialog warns that no phone number is known. An unknown LID with no phone mapping is refused.
- **Untrusted text:** contact names are stripped of control and bidi characters, truncated, and quoted wherever they are shown. Resource cards say their content is data. Prompt injection can at most cause a request, and a human still has to approve the exact recipient and text.
- **Limits:**
  - 4096 characters per message;
  - one send at a time;
  - at least 1.5s between sends;
  - at most 15 sends per minute.
- **Privacy:**
  - Logs contain no message bodies and only masked JIDs (`…1234@s.whatsapp.net`).
  - The journal stores a SHA-256 hash and the length, not the text. Claude Code's own transcript does hold the text.
- **At rest:** `auth/` is unencrypted Baileys credentials, protected only by your OS account. Anyone who copies it can act as this linked device. Revoke it on the phone under WhatsApp → Settings → Linked devices.

## Known limits

- `SENT` means the WhatsApp server accepted the message. Whether it was delivered or read isn't tracked. A recipient who has blocked you still produces `SENT`.
- A reassigned phone number (the old owner changed numbers) can't be detected. The approval dialog shows the number, so check it.
- Local numbers without a country code are refused rather than guessed.
- Server versions before 2.0 don't respect `auth.lock`. After upgrading, restart every Claude Code session.
