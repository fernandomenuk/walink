// WhatsApp groups as first-class recipients, under stricter rules than people (docs/specs/2026-09-25-groups-design.md):
//   - a group is sendable only after the user enables it in a dialog (never by the model)
//   - groups are reached only by an explicit reference (group:<key>) or an alias; never by a plain name or a raw @g.us
//   - groups.json keeps metadata only: never participant lists (every member's number)
//   - stored data is for finding groups; every send re-fetches the group live
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { norm, sanitize } from './contacts.js'
import { log, maskJid } from './log.js'
import { loadJson, writeJsonAtomic } from './persist.js'

export const isGroupJid = (jid) => typeof jid === 'string' && /^\d[\d-]{4,60}@g\.us$/.test(jid)

const bare = (jid) => String(jid ?? '').replace(/:\d+@/, '@')

// Stable across renames and unique across duplicate names: slug of the name + a hash of the (permanent) group ID.
export function groupKey(g) {
  const slug =
    norm(sanitize(g.subject) || 'group')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'group'
  return `${slug}~${createHash('sha256').update(g.jid).digest('hex').slice(0, 6)}`
}

// Your own entry in a participant list. Checks id, phoneNumber and lid against both of your IDs:
// Baileys' own check compares phoneNumber only and misses PN-addressed groups.
export function findMe(participants = [], me) {
  const mine = new Set([me?.pn, me?.lid].filter(Boolean).map(bare))
  return participants.find((p) => [p?.id, p?.phoneNumber, p?.lid].some((j) => j && mine.has(bare(j)))) ?? null
}

// GroupMetadata (Baileys) -> what we keep. No participants.
function fromMeta(m, me) {
  const mine = findMe(m.participants, me)
  return {
    jid: m.id,
    subject: typeof m.subject === 'string' ? m.subject : '',
    size: Number.isFinite(m.size) ? m.size : (m.participants?.length ?? null),
    announce: Boolean(m.announce),
    restrict: Boolean(m.restrict),
    isCommunity: Boolean(m.isCommunity),
    isCommunityAnnounce: Boolean(m.isCommunityAnnounce),
    linkedParent: m.linkedParent ?? null,
    ephemeralDuration: m.ephemeralDuration ?? 0,
    addressingMode: m.addressingMode ?? null,
    amAdmin: Boolean(mine?.admin),
  }
}

export function describeGroup(g) {
  const name = sanitize(g.subject, 100) || '(no name)'
  return `GROUP "${name}"${g.size != null ? ` · ${g.size} members` : ''}`
}

export function createGroupStore(dir, { now = Date.now } = {}) {
  const file = join(dir, 'groups.json')
  const valid = (v) => Array.isArray(v) && v.every((g) => g && isGroupJid(g.jid))
  const load = () => new Map(loadJson(file, valid, []).map((g) => [g.jid, g]))
  let groups = load()
  let seenMtime = mtime()
  let lastSyncedAt = null
  function mtime() {
    try {
      return statSync(file).mtimeMs
    } catch {
      return -1
    }
  }
  // Reads pick up what another session wrote (e.g. a group enabled there) without a restart.
  function current() {
    const m = mtime()
    if (m !== seenMtime) {
      groups = load()
      seenMtime = m
    }
    return groups
  }
  const iso = () => new Date(now()).toISOString()

  // Every write re-reads the file first: another session may have enabled or disabled a group since we loaded.
  function mutate(fn) {
    groups = load()
    const out = fn(groups)
    writeJsonAtomic(file, [...groups.values()])
    seenMtime = mtime()
    return out
  }

  function merge(map, m, me) {
    const prev = map.get(m.id)
    const rec = fromMeta(m, me)
    const renamed = prev && rec.subject && prev.subject !== rec.subject
    map.set(m.id, {
      enabled: false,
      ...prev,
      ...rec,
      state: 'active',
      ...(renamed && { previousSubject: prev.subject, subjectChangedAt: iso() }),
      lastSyncedAt: iso(),
    })
  }

  // A full fetch (groupFetchAllParticipating): known groups missing from it are ones we left (or that are gone).
  function syncAll(byJid, me) {
    const list = Object.values(byJid ?? {}).filter((m) => isGroupJid(m?.id))
    mutate((map) => {
      const seen = new Set(list.map((m) => m.id))
      for (const m of list) merge(map, m, me)
      for (const g of map.values()) if (g.state === 'active' && !seen.has(g.jid)) map.set(g.jid, { ...g, state: 'left', stateAt: iso() })
    })
    lastSyncedAt = now()
    log('info', 'groups_synced', { count: list.length })
  }

  // One live groupMetadata result (before a send, or a join).
  const upsertMeta = (m, me) => isGroupJid(m?.id) && mutate((map) => merge(map, m, me))

  // groups.update: renames and settings. Partial objects; unknown groups are left for the next full sync.
  function applyUpdates(items = []) {
    mutate((map) => {
      for (const u of items) {
        const prev = u?.id && map.get(u.id)
        if (!prev) continue
        const next = { ...prev }
        if (typeof u.subject === 'string' && u.subject && u.subject !== prev.subject) {
          Object.assign(next, { previousSubject: prev.subject, subject: u.subject, subjectChangedAt: iso() })
        }
        for (const k of ['announce', 'restrict']) if (u[k] !== undefined) next[k] = Boolean(u[k])
        if (u.ephemeralDuration !== undefined) next.ephemeralDuration = u.ephemeralDuration ?? 0
        if (Number.isFinite(u.size)) next.size = u.size
        map.set(u.id, next)
      }
    })
  }

  // group-participants.update. Returns 'refetch' when we were added (fetch that group's metadata).
  function applyParticipants({ id, participants = [], action } = {}, me) {
    if (!isGroupJid(id)) return null
    const meHit = findMe(participants, me)
    if (action === 'add' && meHit) return 'refetch'
    return mutate((map) => {
      const prev = map.get(id)
      if (!prev) return null
      const next = { ...prev }
      if (action === 'remove' && meHit) Object.assign(next, { state: 'left', stateAt: iso() })
      else if ((action === 'promote' || action === 'demote') && meHit) next.amAdmin = action === 'promote'
      else if (Number.isFinite(prev.size) && (action === 'add' || action === 'remove')) next.size = Math.max(0, prev.size + (action === 'add' ? 1 : -1) * participants.length)
      map.set(id, next)
      if (next.state === 'left' && prev.state !== 'left') log('info', 'group_left', { jid: maskJid(id) })
      return null
    })
  }

  function setEnabled(jid, enabled) {
    return mutate((map) => {
      const g = map.get(jid)
      if (!g) return null
      const next = enabled ? { ...g, enabled: true, enabledAt: iso(), enabledSubject: g.subject } : { ...g, enabled: false, disabledAt: iso() }
      map.set(jid, next)
      log('info', enabled ? 'group_enabled' : 'group_disabled', { jid: maskJid(jid) })
      return next
    })
  }

  const active = () => [...current().values()].filter((g) => g.state === 'active')

  return {
    syncAll,
    upsertMeta,
    applyUpdates,
    applyParticipants,
    setEnabled,
    reload: () => void ((groups = load()), (seenMtime = mtime())),
    get: (jid) => current().get(jid),
    // The name part of a key is decoration; the ~hash (of the permanent group ID) decides. So a key from before a
    // rename still reaches the same group, and can never reach a different one.
    byKey(key) {
      const hash = /~([0-9a-f]{6})$/.exec(String(key ?? '').trim().toLowerCase())?.[1]
      if (!hash) return null
      const hits = active().filter((g) => groupKey(g).endsWith(`~${hash}`))
      return hits.length === 1 ? hits[0] : null // two groups sharing 24 bits of hash: refuse rather than guess
    },
    // Search by name, for discovery only (whatsapp_find). Never used to pick a send target.
    find(query) {
      const q = norm(query).replace(/^@/, '')
      return q ? active().filter((g) => norm(sanitize(g.subject)).includes(q)) : []
    },
    all: () => [...current().values()],
    enabled: () => active().filter((g) => g.enabled),
    lastSyncedAt: () => lastSyncedAt,
  }
}

// The one entry point for recipients. Groups only by explicit reference; everything else goes to the contact resolver,
// which refuses raw @g.us, broadcast, newsletter and other non-personal IDs.
// -> { group, via } | { match, via, also? } | { candidates } | { error }
export function resolveTarget(to, contacts, groups) {
  const raw = String(to ?? '').trim()
  const ref = /^group:(.+)$/i.exec(raw)
  if (ref) {
    const g = groups?.byKey(ref[1])
    if (g) return { group: g, via: `group reference ${groupKey(g)}` }
    return { error: `no group "${ref[1].trim()}". Group references come from whatsapp_find or whatsapp_groups (they include a ~code, e.g. group:family~3fa9c1).` }
  }
  const aliasJid = contacts.aliasTarget(raw)
  if (aliasJid && isGroupJid(aliasJid)) {
    const g = groups?.get(aliasJid)
    const name = norm(raw.replace(/^@/, ''))
    if (!g) return { error: `@${name} points to a group walink doesn't know yet. Run whatsapp_groups to refresh the group list.` }
    if (g.state !== 'active') return { error: `@${name} points to ${describeGroup(g)}, which you are no longer in.` }
    return { group: g, via: `alias @${name}` }
  }
  return contacts.resolve(raw)
}
