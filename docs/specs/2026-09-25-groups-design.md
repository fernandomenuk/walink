# Design: groups and a unified target model for walink

Status: approved 2026-09-25; phases 1-4 implemented the same day (phase 5, images/videos and upload-once, is still future work).
Implementation notes: group aliases stay plain `alias -> jid` strings (the rename warning compares against the name at enable time); a group key matches on its hash only, so it survives renames.

## Context
walink sends only to individuals today. Groups are refused everywhere (`isAllowedJid` in `lib/contacts.js:8`).
That was a deliberate decision, confirmed twice on 2026-09-25, because group mistakes reach many people and carry
more ban risk. The user now wants groups as first-class recipients, alongside the file sending that already
exists (`file` on `whatsapp_send`, since rc.2).

This design reverses the "groups stay blocked" decision. It does so only under stronger controls than 1:1 sends
have, so the original reasons are answered rather than ignored. After approval: save this as a spec in the repo
(`docs/specs/2026-09-25-groups-design.md`), update `HANDOFF.md`'s decisions, then write a phased implementation
plan. **No code until then.**

### Corrections to the request's assumptions
- **Documents already work.** The file is read once, before the dialog. Files are capped at 100 MB, paths that
  look like secrets get warnings, and the journal never stores the path or the contents. This round extends that;
  it doesn't rebuild it.
- **There's no dry-run any more.** v2 replaced `dry_run`/`confirm_token` with a server-enforced elicitation
  dialog that the model cannot answer. Groups use the same boundary, made stronger.
- **"Never pass a raw JID" isn't true today, even for individuals.** The contact resource card tells Claude to
  call `whatsapp_send` with `to="<jid>"` (`lib/tools.js`, the `card`), and the resolver accepts raw personal JIDs
  (`lib/contacts.js:66-69`). For groups, raw IDs will be refused outright. For contacts, raw personal JIDs stay
  accepted (each one is exactly one person, and the dialog shows them), but the cards should stop pointing Claude
  at them. That's a small follow-up.
- **`wa://contact/…` URIs:** existing `wa://<key>` contact URIs (such as `@walink:wa://akka`) keep working
  unchanged. Groups get a separate `wa://group/<key>` namespace, and there's no second contact URI scheme.

### Decisions made in this brainstorm (user, 2026-09-25)
1. **Opt-in groups.** A group is sendable only after you enable it once, in a dialog Claude can't answer.
2. **Explicit references only.** Groups resolve only through a group reference (`group:<key>`) or an alias you
   bound (`@hushchat`). A plain name like "Family" never matches a group.
3. **For groups over 50 members, the dialog asks you to type the group's name.** Smaller groups get the GROUP
   dialog with a tick.
4. **Media:** documents now. The content model is ready for images and videos later.

## Facts this rests on (Baileys 7.0.0-rc14, verified in `node_modules`)
- **Fetching groups:**
  - `groupFetchAllParticipating()` is a single request that returns `{ jid: GroupMetadata }` and emits
    `groups.update` with it. Baileys itself only calls it after a server "groups dirty" signal, not on connect.
  - `groupMetadata(jid)` is a live fetch, and it **throws** for groups you aren't in (and presumably deleted ones;
    the exact code comes from the server).
- **Metadata fields:**
  - `subject`, `size` (the server's member count; trust it over `participants.length`), `announce` (only admins
    can post).
  - `isCommunity` (a community parent), `isCommunityAnnounce`, `linkedParent`, `ephemeralDuration`,
    `addressingMode` (`pn` or `lid`).
  - `participants[]` holds `{ id, lid?, phoneNumber?, admin }`. `isAdmin` is never set, so use `admin`.
- **Events:**
  - Renames arrive as `groups.update { id, subject }`. Settings changes arrive the same way.
  - `group-participants.update` has the action `add|remove|promote|demote|modify`; a leave arrives as `remove`.
  - `groups.upsert` fires only when a group is created with you in it.
  - **A deleted group emits nothing.**
  - When **you** are removed, Baileys' own "that's me" check compares only `phoneNumber` and misses LID/PN cases.
    walink needs its own check against both `me.id` and `me.lid`.
- **Sending:**
  - For `@g.us`, `relayMessage` fetches the metadata **on every send**, unless `cachedGroupMetadata` is supplied.
    A stale cache means the wrong set of recipients.
  - `sendMessage` returns before WhatsApp acknowledges the message. walink already waits for the
    `CB:ack,class:message` ack itself, so `SENT` stays truthful.
  - There's no client-side check for announce-only groups; the server decides.
- **Media:**
  - The upload (`prepareWAMessageMedia`) happens **before** the message is sent. A crash between the two
    delivers nothing.
  - The message id can be set up front, and it can be reused.
  - Uploaded media can be reused across sends. Image thumbnails need `sharp` or `jimp`, video thumbnails need
    `ffmpeg`, and none of them are installed.

## Approaches compared
**Recipient API**
| Option | For | Against |
| --- | --- | --- |
| A. Add `@g.us` to the allowlist | Tiny | Raw IDs, no names, no safety. Rejected. |
| B. A separate `whatsapp_send_group` tool | Clear intent | Duplicates about 90% of the pipeline; the model can still pick the wrong tool |
| **C. One `whatsapp_send`, with a typed `Target` from an explicit reference (chosen)** | One pipeline, one journal, and group rules layered on top | The resolver gets more complex; this needs good tests |

**Group persistence**
| Option | For | Against |
| --- | --- | --- |
| Fetch live every time, store nothing | Always fresh | No offline listing or resources; a request on every list |
| Store full metadata including participants | Fast | Keeps every member's phone number on disk: a privacy cost for nothing |
| **Store metadata only, and fetch live before each send (chosen)** | Resources and search work offline; the send uses the truth | One extra request per group send (negligible) |

**Refresh**
| Option | For | Against |
| --- | --- | --- |
| Events only | Cheap | Deletions emit nothing; missed events while offline |
| **A full fetch whenever this session takes ownership, plus events, plus the live check before a send (chosen)** | Every gap is covered, and the send can't act on stale data | One request per connect |

**Group references**
| Option | For | Against |
| --- | --- | --- |
| A slug of the subject (`group:hushchat-team`) | Pretty | A rename changes it. A stale reference could then hit *another* group renamed to that name. |
| **Slug plus a hash of the JID (`group:hushchat-team~3fa9`) (chosen)** | Stable across renames, and unique even when names are duplicated | A bit uglier. Aliases (`@hushchat`) are the pretty handle. |

## Architecture
```
whatsapp_send(to, text?, file?)
  └─ resolveTarget(to) ── contacts.js (people, as today)
  │                     └ groups.js (group refs, and aliases bound to groups)   → Target
  └─ Content { text?, attachment?: { kind: 'document', path } }                  (image/video later)
  └─ group gate:  enabled? → live groupMetadata(jid) → member? announce/admin? community parent?
  └─ preview:     GROUP banner, exact name, member count, "everyone will see this", content, warnings
  └─ approval:    tick Send (+ type the group name if size > 50)
  └─ deliver:     upload phase (media) → relay phase → server ack      (the existing queue, journal and ack)
```
- **New: `lib/groups.js`.**
  - A group store (`groups.json`), sync, key generation, and a resolver for group references.
  - Also: the self-membership check (compare the participant `id`, `phoneNumber` and `lid` against
    `me.id`/`me.lid`), and the enable/disable records.
  - Reuses `sanitize`, `norm`, `slug`, `shortHash` and `loadJson`/`writeJsonAtomic` from
    `lib/contacts.js`/`lib/persist.js`.
- **`lib/contacts.js`:**
  - `resolve` stays for people. A new top-level `resolveTarget(input)` routes the input:
    - `group:` and `@alias` → groups when the alias is bound to a group.
    - A raw `@g.us`, `@broadcast`, `@newsletter` or any other server → refused, with "use a group reference from
      whatsapp_find".
    - Everything else → contacts, as today.
  - Aliases become `{ alias: jid }` for people (unchanged) or `{ alias: { jid, kind: 'group', boundSubject } }`
    for groups. The existing file stays compatible.
- **`lib/connection.js`:**
  - `groupFetchAll()`, `groupMetadata(jid)` with a timeout, and forwarding of `groups.update` and
    `group-participants.update`.
  - `cachedGroupMetadata` is backed by a per-send map, so **the send uses exactly the metadata shown in the
    dialog.**
- **`lib/sender.js`:**
  - `send()` works on a `Target`, with a group gate before the dialog.
  - The media deliver step is split into **upload, then relay**. That gives upload failures a *certain*
    `NOT SENT`, and it's what later allows uploading once and sending to many.
- **`lib/approval.js`:** group preview variant; the elicitation schema gains `confirm_name` when the group has
  more than 50 members.
- **`lib/tools.js`:**
  - New tools and resources (below). `INSTRUCTIONS` explain group references.
  - The contact card should point at a reference rather than a raw JID (the follow-up above).

## Data models
```js
Target = { kind: 'contact', jid, name, phone }                       // as today
       | { kind: 'group', jid, key, subject, size, announce, amAdmin, ephemeralDuration, via }
Content = { text?: string, attachment?: { kind: 'document', path, name, size, sha256, mimetype, bytes } }
          // later: kind 'image' | 'video' (needs sharp/jimp + ffmpeg; recompressed, so "exact bytes" won't hold)
// groups.json: metadata only, never participant lists
GroupRecord = { jid, subject, size, announce, restrict, isCommunity, isCommunityAnnounce, linkedParent,
                ephemeralDuration, addressingMode, amAdmin, state: 'active'|'left'|'gone',
                enabled: boolean, enabledAt?, enabledSubject?, subjectChangedAt?, lastSyncedAt }
```
The journal keeps its schema. A group send adds `kind: 'group'`. The fingerprint stays
`hash(caption + file sha)` per JID, so the guard against duplicate and uncertain sends covers groups unchanged.

## MCP surface
| Tool / resource | What it does | Dialog? |
| --- | --- | --- |
| `whatsapp_find` (extends `whatsapp_find_contact`, which stays as an alias) | Searches contacts **and** groups. Groups are listed as `GROUP · "HushChat Team" · 23 members · group:hushchat-team~3fa9 · enabled / not enabled` | no |
| `whatsapp_groups` | Lists groups, enabled ones first. Refreshes if the last sync is older than 10 min | no |
| `whatsapp_group_enable({ group })` | Asks you: "Allow Claude to send to GROUP "HushChat Team" (23 members)? Messages there are seen by everyone." | **yes, the only way to enable** |
| `whatsapp_group_disable({ group })` | Takes a group off the list. Restricting is always safe. | no |
| `whatsapp_set_alias` | Also accepts `group:<key>`. Binding an alias does **not** enable the group. | no |
| `whatsapp_send({ to, text?, file? })` | `to` = contact as today, `group:<key>`, or `@alias` | yes: the GROUP dialog |
| `wa://group/<key>` resources | **Enabled groups only.** The card says it's data and gives `to="group:<key>"` | — |
| `whatsapp_status` | Groups synced, groups enabled, time of the last sync | — |

Why only enabled groups become resources: group names are written by other people (any admin can rename a group).
Listing every group would put all of them in front of the model as a prompt-injection surface, and it would be
noisy. `whatsapp_find` still lets Claude discover the others and tell you to enable one.

## UX flows
**"Send the latest APK to @hushchat"**
1. Claude finds the file itself, with its own file tools (for example the newest `*.apk` by modification time).
   If more than one is plausible, it asks you. walink never searches your disk.
2. `whatsapp_send({ to: '@hushchat', file: 'C:\…\app-release.apk', text: 'v1.4.2 build' })`.
3. The alias leads to the group. The group must be enabled, and the live fetch must show you're still a member,
   the group isn't announce-only (unless you're an admin), and it isn't a community parent.
4. The dialog:
   ```
   ⚠ GROUP · "HushChat Team" · 23 members · everyone in the group will see this
   File: app-release.apk (48.2 MB, sent as a document, modified 3 min ago)
   Path: C:\…\app-release.apk
   Caption:
   ──── v1.4.2 build\n\n— sent by my AI 🤖 ────
   ⚠ Renamed from "HushChat Devs" since you set @hushchat (2026-09-20)     ← only when it applies
   Matched by: alias @hushchat · Disappearing messages: off
   [ Send ☐ ]   (+ "Type the group name to confirm" when over 50 members)
   ```
   "Modified 3 min ago" lets *you* check the "latest" claim.
5. Result: `SENT: file "app-release.apk" to GROUP "HushChat Team" (23 members). The WhatsApp server accepted it…`

**"Send this PDF to the HushChat Team"**
1. A plain name only searches contacts. With no match, the result says: "no contact matches; if you meant a group,
   use whatsapp_find".
2. Claude calls `whatsapp_find("HushChat Team")` and gets `group:hushchat-team~3fa9 (enabled)`, then sends as
   above.
3. If the group isn't enabled: `NOTHING SENT: group "HushChat Team" isn't enabled. Ask the user; they can
   enable it with whatsapp_group_enable (a dialog only they can approve).`

## Send state machine (the journal)
```
pending ──declined|expired──▶ (end)
   │  └─rejected (gate failed: not enabled / not a member / announce-only / wrong typed name)
   ▼ approved
uploading (media only) ──upload error──▶ failed        certain: the message was never sent
   │                   ──crash──▶ on load: failed      certain (research: the upload happens before the relay)
   ▼
sending (written before the relay) ──ack ok──▶ sent
                                   ──error ack──▶ failed
                                   ──timeout/close/throw──▶ unknown
                                   ──crash──▶ on load: unknown
```
The only new state is `uploading`, and it helps contacts too: today an upload failure is reported as
`OUTCOME UNKNOWN`, which is overly cautious.

## Edge cases (decided)
| Case | Behaviour |
| --- | --- |
| Duplicate group names | Unique keys (`~hash`). `whatsapp_find` lists every match. A reference or alias is always one JID, so it's never ambiguous. |
| Duplicate alias | The alias namespace is shared by contacts and groups. Rebinding needs `replace: true` (as today), and the dialog shows "Matched by alias @x". |
| Renamed group | The key and aliases follow the JID. The dialog warns when the subject changed since it was enabled or aliased. Sync records `subjectChangedAt`. |
| Stale metadata | Stored metadata is only used to find and list groups. The send always uses a live `groupMetadata`, which is also handed to `cachedGroupMetadata`. |
| Left, or removed from, a group | The event (with walink's own check against `me.id`/`me.lid`), or its absence from a full fetch, marks it `left`. The live fetch at send time throws → `NOTHING SENT: you're no longer in "X"`. |
| Deleted group | No event exists. It's caught by the full fetch (→ `gone`) or by the live fetch at send time. |
| Group metadata can't be fetched | `NOTHING SENT` with the reason. It never falls back to stored data. |
| Very large group | Over 50 members: you type the name. Over 256: an extra line: "large group: sending may take longer; outcome is reported only after WhatsApp confirms". |
| Announce-only, and you're not an admin | Refused before the dialog. |
| Community parent | Refused, with a pointer to its announcements group. |
| Disappearing messages | Shown in the dialog. Baileys applies the expiry automatically. |
| Concurrent sends | The existing serial queue and pacing. Group sends count against the same 15-per-minute limit. |
| Connection lost during upload | `failed` (certain) → `NOT SENT`, and you can retry freely. |
| Uploaded, then crash before the relay | On restart the journal still says `uploading`, so it becomes `failed`: nothing was delivered. Truthful. |
| Relay done, then crash before the ack | `unknown`. A blind resend is refused; `resend_of` requires you to have checked. |
| The same document twice | The "already sent this N min ago" warning moves to the top of the group dialog. After an uncertain outcome, the existing guard applies. |
| A phone reply typed inside a group | Never treated as input. The phone-channel filter only accepts your own chat. |
| AI signature | Also applies in groups: everyone sees that an AI typed it. |

## Security boundaries
1. **The model can't make a group sendable.** Enabling happens only through a dialog. Disabling is free.
2. **The model can't reach a group by a raw ID or a plain name.** Raw `@g.us`, `@broadcast`, `@newsletter`,
   status and unknown servers are refused by the resolver.
3. **Every group send checks the live group and shows the GROUP dialog.** Over 50 members, you type the name.
   The bytes you approve are the bytes sent, and the recipients are the metadata you saw.
4. **Group names are hostile text.** They're sanitized with the existing `sanitize`. The dialog shows the key's
   hash suffix and any rename warning. Cards and `whatsapp_find` output are marked as data.
5. **Privacy:** `groups.json` never stores participant lists. The journal never stores message text or file
   paths.
6. **The phone channel stays limited to your own chat.** Notifications and questions never go to groups.

## Testing strategy
- **Fake socket additions:** `groupFetchAllParticipating`, `groupMetadata` (with configurable throws), group
  events, and a `cachedGroupMetadata` spy.
- **`groups.test.js`:**
  - Sync marks groups `left`/`gone`.
  - A rename keeps the key and records `subjectChangedAt`.
  - Removing yourself (via LID or PN) is detected.
  - Duplicate names get distinct keys.
  - No participant lists are persisted.
  - Hostile subjects (newlines, bidi characters) are sanitized.
- **Resolver:**
  - A raw `@g.us`, broadcast or newsletter → refused.
  - A plain name never matches a group.
  - `group:<key>` and group aliases resolve.
  - A stale key after a rename → not found (never another group).
- **Enable:** only the dialog enables. The model's call without approval → still disabled.
- **Sender, groups:**
  - Not enabled, not a member, announce-only/non-admin and community parent → `NOTHING SENT` before any dialog.
  - Over 50 members with a wrong typed name → `NOTHING SENT`.
  - The dialog shows the GROUP banner, name, count and the "everyone" line.
  - The send gets the dialog-time metadata.
- **Media phases:**
  - An upload error → `NOT SENT` (certain).
  - Crash injection in `uploading` → `failed` on load; in `sending` → `unknown`, extending `test/crash.test.js`.
- **Duplicates and uncertainty:** the existing guard tests, run against a group target.
- **Live checks,** using a small test group of yours with one friend:
  - Find, enable, alias, send text and a PDF; check the ack.
  - A rename warning.
  - Leave the group, then a send is refused.
  - An announce-only group where you aren't an admin is refused.

## Phasing (each phase shippable and tested on its own)
1. **Read-only groups:** the store, sync, `whatsapp_find`/`whatsapp_groups`, `wa://group/` resources. Nothing is
   sendable yet.
2. **Enable/disable and group aliases.**
3. **Group text sends:** the gate, the GROUP dialog, typed confirmation, `cachedGroupMetadata`.
4. **Upload/relay split** (benefits contacts too), then group documents.
5. **Later, not this round:** images and videos (optional deps, recompression), and upload once / send to many.

## Open questions (verify live, not decidable from code)
- The exact error codes when fetching or sending to a group you left, a deleted group, or an announce-only group
  as a non-admin.
- Whether `groupFetchAllParticipating` omits groups you left. Assumed yes, and the live check covers it either
  way.
- Whether recipients drop a resend that reuses the same message id. If they do, `resend_of` could reuse the id and
  turn a blind duplicate into a no-op. Until that's verified, resends get a new id, as today.
