// One process owns the WhatsApp session (auth/). Others become read-only followers.
// Lock = file created with O_EXCL holding {pid, startedAt}; the owner touches it every few seconds.
// Stale when the pid is gone OR the heartbeat stopped (covers Windows pid reuse after a reboot).
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { log } from './log.js'
import { writeJsonAtomic } from './persist.js'

const HEARTBEAT_MS = 5_000
const STALE_MS = 30_000

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function readHolder(file) {
  try {
    return { ...JSON.parse(readFileSync(file, 'utf8')), mtimeMs: statSync(file).mtimeMs }
  } catch {
    try {
      return { pid: null, mtimeMs: statSync(file).mtimeMs } // being written right now, or garbage
    } catch {
      return null // vanished
    }
  }
}

// Returns { owner: true } or { owner: false, holder: {pid, startedAt} }.
export function acquireLock(file, { pid = process.pid, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }))
      closeSync(fd)
      return { owner: true }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const holder = readHolder(file)
    if (!holder) continue
    if (holder.pid === pid) return { owner: true }
    const age = now() - holder.mtimeMs
    const stale = holder.pid ? !isAlive(holder.pid) || age > STALE_MS : age > STALE_MS
    if (!stale) return { owner: false, holder }
    // ponytail: two followers can race to clear the same stale lock; O_EXCL create still admits only one,
    // the loser sees the winner's fresh lock next iteration. Ceiling: a clear landing between the winner's
    // create and write; upgrade path is an OS lock (e.g. proper-lockfile) if that ever shows up.
    log('warn', 'lock_stale_cleared', { stalePid: holder.pid, ageMs: Math.round(age) })
    try {
      unlinkSync(file)
    } catch {}
  }
  return { owner: false, holder: readHolder(file) }
}

export function startHeartbeat(file) {
  const t = setInterval(() => {
    try {
      const d = new Date()
      utimesSync(file, d, d)
    } catch (e) {
      log('error', 'lock_heartbeat_failed', { err: e.message })
    }
  }, HEARTBEAT_MS)
  t.unref()
  return () => clearInterval(t)
}

export function releaseLock(file, pid = process.pid) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file)
  } catch {}
}

// Handover: a follower whose user approved a send asks the owner to step down by writing `<lock>.handover`.
// The owner finishes in-flight sends, releases the lock, and becomes a follower; the requester removes the file.
export const handoverFile = (lockFile) => `${lockFile}.handover`

export function requestHandover(file, pid = process.pid) {
  writeJsonAtomic(file, { pid, ts: new Date().toISOString() })
}

// The pending request, or null. Requests from dead processes are ignored.
export function handoverRequest(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'))
    return r?.pid && isAlive(r.pid) ? r : null
  } catch {
    return null
  }
}

export function clearHandover(file, pid = process.pid) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file)
  } catch {}
}
