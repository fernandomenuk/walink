# Handoff: walink (WhatsApp MCP for Claude Code)

Last updated 2026-09-25, at the end of the second session. Items marked **TODO** are unfinished.

## Where things are

| What | Where |
| --- | --- |
| Code | `C:\Users\User\dev\active\whatsapp-automation`. The folder isn't renamed on purpose, because the MCP registration points here. |
| GitHub | https://github.com/fernandomenuk/walink (private), branch `main`. Everything is pushed. |
| Latest release | **v2.0.0-rc.3 (preprod)**: a GitHub prerelease with the `.tgz` attached, plus GitHub Packages `@fernandomenuk/walink@2.0.0-rc.3` (dist-tag `next`). Older releases: rc.0 (GitHub only), rc.1, rc.2. |
| npm (npmjs.com) | `@fernandomenuk/walink`. **Not published.** No `NPM_TOKEN` secret yet; the release workflow skips npm until one is set. |
| Claude Code MCP | Registered at user scope as `walink` → `node C:\Users\User\dev\active\whatsapp-automation\server.js` |
| Runtime data | `~/.whatsapp-mcp/`: `auth/` (linked-device creds, unencrypted), `auth.lock` (+ `auth.lock.handover` during a handover), `contacts.json` (~2,446), `aliases.json`, `sends.jsonl` (the send and question journal; never message text) |
| Audit doc | "WhatsApp MCP Review Answers" (Claude Docs): https://claude.ai/code/artifact/99dbc6e0-1fc2-473e-8e76-d78e313afa63. It covers the **old** v1 code. |

## What walink does now
- **Send text or files** (`whatsapp_send`) to any individual contact. Each send shows a server-enforced approval dialog, where you tick **Send** and then Accept.
  - The dialog leads with the recipient and the text, or the file's name, size and path, because Claude Code collapses it to its first lines.
  - Messages to other people end with `🤖 This message is written by Claude`.
- **Your own chat needs no dialog**: `me`, `whatsapp_notify_me`, `whatsapp_ask_me`. Those messages are headed `🤖 walink · <folder>`.
- **Phone channel:**
  - `whatsapp_ask_me` asks you on WhatsApp and waits (up to 25 min per call). Reply with a number or text, and swipe-reply if several questions are open. You'll see ✅.
  - Late replies, and messages you start with `@claude`, are pushed into the session. You'll see 👀.
  - This needs Claude Code started with `claude --dangerously-load-development-channels server:walink`.
- **Several sessions:** one owns WhatsApp and the others follow.
  - An approved send in a follower takes WhatsApp over, with one dialog.
  - A notification or question from a follower asks *softly*, and the owner declines while it's waiting for your reply.
- **Safety:**
  - `SENT` only on WhatsApp's server ack, with `OUTCOME UNKNOWN` otherwise.
  - Blind resends are refused.
  - Groups only when you enabled them (dialog), only by `group:<key>` or an alias, with a GROUP dialog on every send (type the name above 50 members). Raw `@g.us`, broadcasts and newsletters are refused.
  - Rate limits: at least 1.5s between sends, at most 15 per minute.
  - Forwarded messages are never read as input.
  - Old messages are never replayed.

Design, failure semantics and the security model are in `docs/DESIGN.md`. User docs are in `README.md`.

## What was done

**Session 1**
- Audited v1 and rebuilt it as v2: elicitation approval, the send journal, ack-based `SENT`, the allowlist, the single-owner lock, backoff, the send queue, atomic files, and 60 tests.
- Renamed it to walink and set up MIT licensing, CI on Windows and Linux, and tag-driven releases.

**Session 2**, commits in order:
1. `0beffdd` The approval preview puts the recipient and text first. It had been hidden behind "+8 more lines".
2. `49188c2` Session handover inside the send dialog.
3. `b1e8889`, `64c633b`, `c9f51ae` Release workflow changes:
   - npm is optional while `NPM_TOKEN` is unset.
   - The release gets the `npm pack` tarball.
   - It also publishes to GitHub Packages, using a second `setup-node` step for auth.
4. `f3efafc` Send files as WhatsApp documents (`lib/file.js`).
   - The file is read once, before the dialog; those bytes are what's sent.
   - Limit of 100 MB.
   - Warnings for secret-looking paths, links and files outside home.
   - The journal stores name, size and sha256, never the path or contents.
5. `95b6cc2` Your own chat without a dialog, plus `whatsapp_notify_me`.
6. `d5872fe` Phone channel (`lib/phone.js`): `whatsapp_ask_me`, reply matching, the inbound filter, and channel pushes (the `claude/channel` capability).
7. `d6d479e` Soft handover for the phone channel, plus docs.
8. `e072a74` AI signature on messages to others, and the `🤖 walink · <folder>` header.
9. Version bumps and releases: rc.1 (`505b2a8`), rc.2 (`a11f747`), rc.3 (`323d3de`).

Tests: **95** (`npm test`); 94 pass and 1 is skipped on Windows (a symlink test that needs Developer Mode; it runs in CI on Linux).

## Decisions made (don't re-ask)
- **No elicitation support** → refuse to send. There's no weaker fallback.
- **Recipients:** individuals and **opt-in groups** (implemented 2026-09-25, not yet live-tested). On 2026-09-25 the user reversed the earlier "groups stay blocked" decision, under stricter rules. See `docs/specs/2026-09-25-groups-design.md`:
  - Groups are opt-in: you enable each one in a dialog.
  - Groups resolve only through an explicit reference (`group:<key>`) or an alias; a plain name never matches a group.
  - For groups over 50 members, you type the group's name to confirm.
  - Media stays documents only; images and videos come later.
  - Raw `@g.us`, broadcast and newsletter IDs are never accepted.
- **Second session:** it follows. An approved send there takes over, in one dialog. There's no relay between sessions.
- **Your own chat skips the dialog.** It can only reach you.
- **Remote approval** of sends to *other people* from the phone: **not now**.
- **Phone → Claude:** only `@claude …` messages, plus replies to open questions. Other self-notes stay private.
- **Files:** any file, always as a document, through `file` on `whatsapp_send`. The user is the gate, with warnings in the dialog.
- **Signature** on every message to others: one fixed line, `🤖 This message is written by Claude` (the user replaced the rotating lines on 2026-09-25). Header on your own chat: `🤖 walink · <folder>`.
- **Tool names** keep the `whatsapp_` prefix; the server name is `walink`.
- **Publishing:**
  - Releases are triggered by tags.
  - The GitHub release and GitHub Packages are always published; npmjs.com only once `NPM_TOKEN` is set.
  - MIT license.

## Live test results
- **Working:**
  - Status (owner, connected, elicitation supported). The dialog works in bypass-permissions mode.
  - Send to `me` → `SENT`, and decline → `NOTHING SENT`.
  - A group JID is refused before any dialog.
  - The second-session follower, and a handover in both directions.
  - A file (`.tgz`) to `me` arrived as a document.
  - `whatsapp_notify_me`, with no dialog.
  - `whatsapp_ask_me`: the reply "yes" came back as `REPLY`.
  - Text sends to Akka, including Sinhala.
- **Gotcha:** Accept without ticking **Send** is a decline. The keys are ↑ to `Send:`, Space, then Accept.
- **TODO, not live-tested yet** (these need channels):
  - A late reply after `NO REPLY YET` should appear in the session.
  - `@claude …` from the phone → 👀, and it reaches the session. A plain note does nothing.
  - A forwarded message → ⚠️, and it's ignored.
  - Swipe-reply matching when several questions are open.
  - Esc during `whatsapp_ask_me` → `CANCELLED`, and the question is edited on WhatsApp.
  - The ✅ reaction on answers.
- **Optional:** Wi-Fi off mid-send → `OUTCOME UNKNOWN`. It's covered by the crash-injection tests.

## TODO, in order
1. **Live-test the channel items above.**
   - Exit, then run `claude --dangerously-load-development-channels server:walink` in this folder.
   - Unknowns to watch:
     - Does Claude Code actually deliver `<channel source="walink">` messages?
     - Does Esc send a cancellation that the server sees?
     - Do progress notifications keep a long `whatsapp_ask_me` alive past the 30-min idle timeout? The design caps each wait at 25 min anyway.
2. **npm publishing** (optional; GitHub Packages works already):
   - Confirm the npm username with `npm whoami`.
   - Create an npm Automation token and run `gh secret set NPM_TOKEN`.
   - Re-run the latest release.
3. **Promote to prod** once happy: `npm version 2.0.0 && git push --follow-tags`. The commit must be on `main`.
4. **Sharing with someone** (for example Akka):
   - The repo is private. Either add them as a collaborator, or send them the release `.tgz`.
   - They install with `npm i -g ./fernandomenuk-walink-<ver>.tgz` or `npm i -g github:fernandomenuk/walink#v2.0.0-rc.3`.
   - Then `walink login`, then `claude mcp add walink -s user -- walink`. On Windows, use `-- cmd /c walink`.
   - They link *their own* WhatsApp. Tell them about the Baileys and unofficial-client account risk.
   - Nobody has sent rc.3 to Akka yet. Only the rc.1 file was downloaded, to `~/Downloads`.
5. **Optional:** required reviewers on the `production` environment. That needs a paid GitHub plan on a private repo.

## Idea backlog (from brainstorming; not started)
- **Read messages**: "what did Akka reply?". Needs careful prompt-injection handling, because other people's text would be treated as data.
- **Unsend and edit** the last message. Small, and a real safety net.
- **Delivered/read receipts** in the status and the journal.
- **Phone as an input device**: screenshots and voice notes sent to your own chat → Claude.
- **Scheduled sends.** Needs a running session or a background service.
- **Permission relay**: approve Claude Code permission prompts from the phone (the `claude/channel/permission` capability). Moot while running in bypass mode.
- **Remote approval** of sends to others (a one-time code reply). Deferred on purpose.

## Handy commands
```sh
npm test                          # 95 tests
npm run login                     # re-link / refresh contacts (QR). Refuses if a session holds auth.lock:
                                  #   stop that session's walink server first, and run it in its own terminal window
gh run list --limit 5             # CI / release runs
gh release list                   # releases
claude mcp get walink             # check the registration
claude --dangerously-load-development-channels server:walink   # enable the phone channel for a session
```
- After changing walink's code, run `/mcp` and reconnect `walink` in the session. The running server keeps the old code until then.
- Your local `gh` token can't read packages (it lacks `read:packages`). Check GitHub Packages in the release run's log instead.

## Known limits (by design, documented)
- `SENT` means WhatsApp's server accepted the message. Delivery and read receipts aren't tracked, and a block can't be detected.
- A reassigned phone number can't be detected. The dialog shows the number.
- Local numbers without a country code are refused.
- New contacts appear as resources only after `/mcp` reconnects.
- Files are capped at 100 MB and held in memory while sending.
- The phone channel reaches only the session that owns WhatsApp. Pushes are dropped if that session wasn't started with channels, and walink can't detect that. The 👀 reaction only means "handed to the session".
- Questions expire after 24h. Answers are stored in the journal by id and length, never their text.
