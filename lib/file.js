// Files sent as WhatsApp documents. The file is read ONCE, before the approval dialog: those exact bytes are
// what goes out, so changing the file on disk after approval cannot change what is sent.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, normalize, relative } from 'node:path'

export const MAX_FILE_BYTES = 100 * 1024 * 1024

// ponytail: small built-in table; anything else goes as application/octet-stream, which WhatsApp handles fine.
const MIME = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive',
}

// Paths that usually hold keys, tokens or credentials. A match only warns in the dialog; the user decides.
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.whatsapp-mcp'])
const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_.*|credentials.*|secrets.*)$|\.(pem|key|p12|pfx)$/i

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

// { error } | { realPath, name, size, bytes, sha256, mimetype, warnings }
export function loadFile(path, { maxBytes = MAX_FILE_BYTES, home = homedir() } = {}) {
  if (typeof path !== 'string' || !path.trim()) return { error: 'the file path is empty' }
  if (!isAbsolute(path)) return { error: `"${path}" is not an absolute path; pass the full path to the file` }
  let realPath, bytes
  try {
    realPath = realpathSync(path)
    const st = statSync(realPath)
    if (!st.isFile()) return { error: `${realPath} is not a regular file` }
    if (st.size > maxBytes) return { error: `${realPath} is ${formatBytes(st.size)}; the limit is ${formatBytes(maxBytes)}` }
    bytes = readFileSync(realPath)
  } catch (e) {
    return { error: e.code === 'ENOENT' ? `there is no file at ${path}` : `cannot read ${path} (${e.code || e.message})` }
  }
  if (!bytes.length) return { error: `${realPath} is empty` }
  if (bytes.length > maxBytes) return { error: `${realPath} is ${formatBytes(bytes.length)}; the limit is ${formatBytes(maxBytes)}` }

  const name = basename(realPath)
  const warnings = []
  if (realPath.split(/[\\/]/).some((p) => SECRET_DIRS.has(p.toLowerCase())) || SECRET_NAME.test(name)) {
    warnings.push('This path looks like it may hold secrets (keys, tokens, credentials). Make sure this is the file you mean to share.')
  }
  if (!samePath(normalize(path), realPath)) warnings.push(`${path} is a link; the file actually sent is ${realPath}.`)
  const rel = relative(home, realPath)
  if (rel.startsWith('..') || isAbsolute(rel)) warnings.push('This file is outside your home folder.')

  return {
    realPath,
    name,
    size: bytes.length,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimetype: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
    warnings,
  }
}
