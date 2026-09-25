// Contact store + conservative resolution. Never guesses between matches; only personal-chat JIDs pass.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { log, maskJid } from './log.js'
import { loadJson, writeJsonAtomic } from './persist.js'

// Only 1:1 chats. Groups (@g.us), broadcasts, newsletters and anything else are refused everywhere.
export const isAllowedJid = (jid) => typeof jid === 'string' && /^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(jid)
export const isLid = (jid) => jid.endsWith('@lid')

export const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().trim()

// Contact names are attacker-controllable text: strip control/format chars (bidi overrides, zero-width),
// keep ZWJ so emoji sequences survive, collapse whitespace, cap length.
export function sanitize(s, max = 64) {
  const clean = String(s ?? '')
    .normalize('NFKC')
    .replace(/(?!\u200d)[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export const label = (c) => sanitize(c.name || c.notify) || null

// Returns null (not phone-shaped), {digits}, or {error}.
export function parsePhone(input) {
  const raw = String(input).trim()
  if (!/^\(?\+?[\d\s\-().]+$/.test(raw)) return null
  const intl = /^\(?\+/.test(raw)
  let d = raw.replace(/[\s\-().+]/g, '')
  if (d.length < 6) return null
  if (!intl && d.startsWith('00')) d = d.slice(2)
  else if (!intl && d.startsWith('0')) {
    return { error: `"${raw}" looks like a local number; include the country code (e.g. +94…)` }
  }
  if (!/^[1-9]\d{7,14}$/.test(d)) return { error: `"${raw}" is not a valid international number (8–15 digits)` }
  return { digits: d }
}

// Human-readable identity used in previews and results.
export function describe(c) {
  const name = label(c)
  const who = name ? `"${name}"` : '(no name)'
  const phone = c.phone ? `+${c.phone}` : isLid(c.jid) ? 'no phone number known' : `+${c.jid.split('@')[0]}`
  return `${who} · ${phone} · ${c.jid}`
}

const NOT_PERSONAL = (raw) =>
  /@g\.us$/i.test(String(raw).trim())
    ? `"${raw}" is a raw group ID. Groups are reached only by a group reference (group:<key>) from whatsapp_find, or an alias the user set.`
    : `"${raw}" is not a personal chat. Broadcasts, newsletters and other addresses are not supported.`

// Pure resolver. Result: {match, via, also?} | {candidates: [...]} (0 = none, ≥2 = ambiguous) | {error}
export function resolve(query, contacts, aliases = {}) {
  const raw = String(query ?? '').trim()
  const bare = raw.replace(/^@/, '')
  const q = norm(bare)
  if (!q) return { error: 'recipient is empty' }
  const byJid = (jid) => contacts.find((c) => c.jid === jid)

  if (Object.hasOwn(aliases, q)) {
    const jid = aliases[q]
    if (!isAllowedJid(jid)) return { error: `alias @${q} points to ${jid}. ${NOT_PERSONAL(jid)}` }
    return { match: byJid(jid) || { jid }, via: `alias @${q}` }
  }

  if (q.includes('@')) {
    if (!isAllowedJid(q)) return { error: NOT_PERSONAL(raw) }
    return { match: byJid(q) || { jid: q }, via: 'chat ID' }
  }

  const phone = parsePhone(bare)
  if (phone?.error) return { error: phone.error }
  if (phone) {
    const jid = `${phone.digits}@s.whatsapp.net`
    const known = contacts.find((c) => c.jid === jid || c.phone === phone.digits)
    return { match: known || { jid, phone: phone.digits }, via: 'phone number' }
  }

  const names = (c) => [c.name, c.notify].filter(Boolean).map(norm)
  const prefix = contacts.filter((c) => names(c).some((n) => n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))))
  const exact = contacts.filter((c) => names(c).includes(q))
  if (exact.length === 1) return { match: exact[0], via: 'exact name', also: prefix.filter((c) => c !== exact[0]) }
  if (exact.length > 1) return { candidates: exact }
  if (prefix.length === 1) return { match: prefix[0], via: 'name prefix' }
  return { candidates: prefix }
}

const slug = (c) =>
  norm(label(c) || 'contact')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '') || 'contact'
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 6)

// wa://nabeel, or wa://nabeel-3fa9c1 (stable hash of the JID) when names collide.
export function resourceKeys(contacts) {
  const named = contacts.filter((c) => label(c))
  const counts = new Map()
  for (const c of named) counts.set(slug(c), (counts.get(slug(c)) || 0) + 1)
  return new Map(named.map((c) => [counts.get(slug(c)) > 1 ? `${slug(c)}-${shortHash(c.jid)}` : slug(c), c]))
}

const ALIAS_KEY = /^[\p{L}\p{M}\p{N}_.-]{1,40}$/u

export function createContactStore(dir, { debounceMs = 1000 } = {}) {
  const file = join(dir, 'contacts.json')
  const aliasFile = join(dir, 'aliases.json')
  const loadContacts = () =>
    loadJson(file, (v) => Array.isArray(v) && v.every((c) => c && typeof c.jid === 'string'), []).map((c) => [c.jid, c])
  const loadAliases = () =>
    loadJson(
      aliasFile,
      (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'),
      {},
    )
  const contacts = new Map(loadContacts())
  const aliases = loadAliases()
  // Another process (the session owner) may have written since we loaded: re-read before read-modify-write.
  const reloadAliases = () => {
    for (const k of Object.keys(aliases)) delete aliases[k]
    Object.assign(aliases, loadAliases())
  }
  const isGroupAliasJid = (jid) => /^\d[\d-]{4,60}@g\.us$/.test(jid) // aliases may point at groups (lib/groups.js)
  const badAliases = Object.entries(aliases).filter(([, jid]) => !isAllowedJid(jid) && !isGroupAliasJid(jid)).map(([k]) => k)
  if (badAliases.length) log('warn', 'aliases_not_personal', { aliases: badAliases })

  let timer = null
  let dirty = false
  const flush = () => {
    clearTimeout(timer)
    timer = null
    if (!dirty) return
    dirty = false
    writeJsonAtomic(file, [...contacts.values()])
  }

  function upsert(list = []) {
    for (const c of list) {
      if (!c?.id || !isAllowedJid(c.id)) continue
      const prev = contacts.get(c.id) || { jid: c.id }
      const pn = c.phoneNumber || (c.id.endsWith('@s.whatsapp.net') ? c.id : undefined)
      const next = {
        ...prev,
        ...(c.name && { name: c.name }),
        ...(c.notify && { notify: c.notify }),
        ...(pn && { phone: pn.split('@')[0].split(':')[0] }),
      }
      if (JSON.stringify(next) === JSON.stringify(prev) && contacts.has(c.id)) continue
      contacts.set(c.id, next)
      dirty = true
    }
    if (dirty && !timer) timer = setTimeout(flush, debounceMs)
  }

  // Point an alias at a JID (a person, or a group resolved by the caller). describeOld names the previous target.
  function bindAlias(alias, jid, { replace = false, describeOld = (j) => describe(contacts.get(j) || { jid: j }) } = {}) {
    reloadAliases()
    const key = norm(String(alias).replace(/^@/, ''))
    if (!ALIAS_KEY.test(key) || key === '__proto__') return { error: `"${alias}" is not a valid alias (letters, digits, _ . - ; max 40)` }
    const old = Object.hasOwn(aliases, key) ? aliases[key] : undefined
    if (old && old !== jid && !replace) return { error: `@${key} already points to ${describeOld(old)}. Pass replace=true to repoint it.` }
    aliases[key] = jid
    writeJsonAtomic(aliasFile, aliases)
    log('info', 'alias_set', { alias: key, jid: maskJid(jid), replaced: Boolean(old && old !== jid) })
    return { key, previous: old && old !== jid ? old : null }
  }

  function setAlias(alias, to, { replace = false } = {}) {
    reloadAliases()
    const r = resolve(to, [...contacts.values()], aliases)
    if (r.error) return { error: r.error }
    if (!r.match) {
      return { error: `"${to}" is ${r.candidates.length ? 'ambiguous' : 'not found'}; use a phone number or the chat ID from whatsapp_find_contact` }
    }
    const b = bindAlias(alias, r.match.jid, { replace })
    if (b.error) return b
    return { key: b.key, contact: r.match, previous: b.previous ? contacts.get(b.previous) || { jid: b.previous } : null }
  }

  return {
    upsert,
    flush,
    setAlias,
    bindAlias,
    resolve: (q) => resolve(q, [...contacts.values()], aliases),
    // The JID an alias points to (with or without "@"), or null.
    aliasTarget(q) {
      const key = norm(String(q ?? '').trim().replace(/^@/, ''))
      return key && Object.hasOwn(aliases, key) ? aliases[key] : null
    },
    // Called when this process takes over the session: pick up what the previous owner wrote.
    reload() {
      for (const [jid, c] of loadContacts()) contacts.set(jid, { ...c, ...contacts.get(jid) })
      reloadAliases()
    },
    get: (jid) => contacts.get(jid),
    all: () => [...contacts.values()],
    keys: () => resourceKeys([...contacts.values()]),
    get size() {
      return contacts.size
    },
    badAliases,
  }
}
