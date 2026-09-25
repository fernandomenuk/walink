// Crash-safe file helpers: atomic JSON replace, validated load with quarantine, fsync'd JSONL append.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { log } from './log.js'

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function writeFileSynced(file, data, flags) {
  const fd = openSync(file, flags)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Write to a temp file, fsync, then rename over the target: readers see the old or the new file, never half of one.
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSynced(tmp, JSON.stringify(value, null, 2), 'w')
  for (let i = 0; ; i++) {
    try {
      return renameSync(tmp, file)
    } catch (e) {
      // Windows: antivirus/indexers briefly lock files
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      sleepSync(25 * (i + 1))
    }
  }
}

// Files that failed to parse/validate, moved aside so the server can start. Reported by whatsapp_status.
export const quarantined = []

export function loadJson(file, validate, fallback) {
  if (!existsSync(file)) return fallback
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!validate(value)) throw new Error('unexpected shape')
    return value
  } catch (e) {
    const dest = `${file}.corrupt-${Date.now()}`
    renameSync(file, dest)
    quarantined.push(dest)
    log('warn', 'file_quarantined', { file: dest, reason: e.message })
    return fallback
  }
}

export function appendJsonLine(file, obj) {
  writeFileSynced(file, `${JSON.stringify(obj)}\n`, 'a')
}

// A crash mid-append can leave a torn last line: skip unparseable lines instead of failing.
export function readJsonLines(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      log('warn', 'journal_torn_line', { file })
    }
  }
  return out
}

// Terminate a torn last line so the next append starts on a fresh line.
export function ensureTrailingNewline(file) {
  if (!existsSync(file) || statSync(file).size === 0) return
  const text = readFileSync(file, 'utf8')
  if (!text.endsWith('\n')) writeFileSynced(file, '\n', 'a')
}
