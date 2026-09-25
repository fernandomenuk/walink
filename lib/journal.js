// Append-only send journal (sends.jsonl). Each line is a partial record for one reqId; the fold
// (later lines win) is the current state. Stores a hash + length of the text, never the text.
//
// States: pending -> declined | expired | rejected | uploading (media) | sending
//         uploading -> failed (certain: nothing was sent) | sending
//         sending -> sent | failed | unknown
// Left behind by a crash, on load: `sending` -> `unknown`, `uploading` -> `failed`, `pending` -> `expired`.
// Question records (phone channel) share the file: { reqId: 'Q<n>', type: 'question', ... }.
import { createHash } from 'node:crypto'
import { existsSync, renameSync, statSync } from 'node:fs'
import { log } from './log.js'
import { appendJsonLine, ensureTrailingNewline, readJsonLines } from './persist.js'

export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const OPEN = new Set(['sending', 'unknown'])
const DUP_WINDOW_MS = 24 * 60 * 60 * 1000

export function createJournal(file, { now = Date.now, maxBytes = 5_000_000 } = {}) {
  const reqs = new Map()
  const msgIds = new Set() // every message id walink sent, so its own messages are never read back as input
  const merge = (r) => {
    if (r.msgId) msgIds.add(r.msgId)
    reqs.set(r.reqId, { ...reqs.get(r.reqId), ...r })
  }

  function append(rec) {
    const full = { ...rec, ts: new Date(now()).toISOString() }
    appendJsonLine(file, full)
    merge(full)
    return reqs.get(rec.reqId)
  }

  // Load, recover crashed requests, rotate if large. Only the lock owner may call this.
  function load() {
    ensureTrailingNewline(file)
    reqs.clear()
    for (const r of readJsonLines(file)) if (r?.reqId) merge(r)

    if (existsSync(file) && statSync(file).size > maxBytes) {
      // Keep what still matters (open outcomes and the last day) in the fresh file.
      renameSync(file, `${file}.1`)
      const keep = [...reqs.values()].filter((r) => OPEN.has(r.state) || now() - Date.parse(r.ts) < DUP_WINDOW_MS)
      for (const r of keep) appendJsonLine(file, r)
      log('info', 'journal_rotated', { kept: keep.length })
    }

    for (const r of [...reqs.values()]) {
      if (r.state === 'sending') {
        append({ reqId: r.reqId, state: 'unknown', reason: 'server stopped after the send started (crash or restart)' })
        log('warn', 'send_outcome_unknown_after_restart', { reqId: r.reqId })
      } else if (r.state === 'uploading') {
        // The upload always finishes before the message is relayed, so a crash here sent nothing.
        append({ reqId: r.reqId, state: 'failed', reason: 'server stopped during the upload; nothing was sent' })
      } else if (r.state === 'pending') {
        append({ reqId: r.reqId, state: 'expired', reason: 'server stopped while waiting for approval' })
      }
    }
    return api
  }

  // An earlier attempt at this exact jid+text whose outcome is not known and not yet acknowledged.
  const findUncertain = (jid, textHash) =>
    [...reqs.values()]
      .filter((r) => OPEN.has(r.state) && !r.resolvedBy && r.jid === jid && r.textHash === textHash)
      .filter((r) => now() - Date.parse(r.ts) < DUP_WINDOW_MS)
      .at(-1)

  const findRecentSent = (jid, textHash, windowMs = 10 * 60 * 1000) =>
    [...reqs.values()]
      .filter((r) => r.state === 'sent' && r.jid === jid && r.textHash === textHash && now() - Date.parse(r.ts) < windowMs)
      .at(-1)

  const unresolvedUnknown = () => [...reqs.values()].filter((r) => r.state === 'unknown' && !r.resolvedBy)

  const api = { load, append, get: (id) => reqs.get(id), records: () => [...reqs.values()], hasMsgId: (id) => msgIds.has(id), findUncertain, findRecentSent, unresolvedUnknown }
  return api
}
