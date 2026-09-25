import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatBytes, loadFile } from '../lib/file.js'
import { tmp } from './helpers.js'

test('loadFile: reads the bytes once, with name, size, sha256 and MIME type', () => {
  const dir = tmp()
  const path = join(dir, 'walink-2.0.0.tgz')
  writeFileSync(path, 'tarball bytes')
  const f = loadFile(path, { home: dir })
  assert.equal(f.error, undefined)
  assert.equal(f.name, 'walink-2.0.0.tgz')
  assert.equal(f.size, 13)
  assert.equal(f.bytes.toString(), 'tarball bytes')
  assert.equal(f.sha256, createHash('sha256').update('tarball bytes').digest('hex'))
  assert.equal(f.mimetype, 'application/gzip')
  assert.deepEqual(f.warnings, [])
  assert.equal(loadFile(join(dir, 'x'), { home: dir }).error?.includes('no file'), true)
  writeFileSync(join(dir, 'blob.xyz'), 'x')
  assert.equal(loadFile(join(dir, 'blob.xyz'), { home: dir }).mimetype, 'application/octet-stream')
})

test('loadFile: refuses relative paths, folders, empty and oversized files, and missing files', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'empty.txt'), '')
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(11))
  const cases = [
    ['notes.txt', /not an absolute path/],
    ['', /empty/],
    [dir, /not a regular file/],
    [join(dir, 'empty.txt'), /is empty/],
    [join(dir, 'big.bin'), /11 B; the limit is 10 B/],
    [join(dir, 'missing.pdf'), /there is no file/],
  ]
  for (const [path, re] of cases) assert.match(loadFile(path, { maxBytes: 10, home: dir }).error ?? '', re, path)
})

test('loadFile: warns about secret-looking paths and files outside the home folder', () => {
  const home = tmp()
  mkdirSync(join(home, '.ssh'))
  for (const [rel, content] of [['.ssh/config', 'Host x'], ['.env', 'KEY=1'], ['server.pem', 'x'], ['id_ed25519', 'x']]) {
    writeFileSync(join(home, rel), content)
    assert.match(loadFile(join(home, rel), { home }).warnings.join('\n'), /may hold secrets/, rel)
  }
  writeFileSync(join(home, 'report.pdf'), 'x')
  assert.match(loadFile(join(home, 'report.pdf'), { home: join(home, 'elsewhere') }).warnings.join('\n'), /outside your home folder/)
})

test('loadFile: a link shows the real target that will be sent', (t) => {
  const dir = tmp()
  writeFileSync(join(dir, 'real.txt'), 'x')
  try {
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'))
  } catch {
    return t.skip('cannot create symlinks here (Windows without Developer Mode)')
  }
  const f = loadFile(join(dir, 'link.txt'), { home: dir })
  assert.equal(f.name, 'real.txt')
  assert.match(f.warnings.join('\n'), /link\.txt is a link; the file actually sent is .*real\.txt/)
})

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(23_270), '22.7 KB')
  assert.equal(formatBytes(100 * 1024 * 1024), '100.0 MB')
})
