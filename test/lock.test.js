import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, releaseLock } from '../lib/lock.js'
import { tick, tmp } from './helpers.js'

const HOLDER = new URL('./fixtures/hold-lock.js', import.meta.url)

test('second process is a follower until the owner dies, then takes over', async () => {
  const file = join(tmp(), 'auth.lock')
  const child = fork(HOLDER, [file], { stdio: 'ignore', env: { ...process.env, WA_LOG: 'silent' } })
  await new Promise((r) => child.once('message', r)) // child owns the lock
  const follower = acquireLock(file)
  assert.equal(follower.owner, false)
  assert.equal(follower.holder.pid, child.pid)
  child.kill('SIGKILL') // no chance to clean up
  await new Promise((r) => child.once('exit', r))
  await tick(50)
  assert.equal(acquireLock(file).owner, true)
  releaseLock(file)
})

test('lock with a live pid but a dead heartbeat is stale (pid reuse after reboot)', () => {
  const file = join(tmp(), 'auth.lock')
  writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: 'x' })) // some other live process
  const old = new Date(Date.now() - 60_000)
  utimesSync(file, old, old)
  assert.equal(acquireLock(file).owner, true)
})

test('a lock being written right now (empty file) is respected', () => {
  const file = join(tmp(), 'auth.lock')
  writeFileSync(file, '')
  assert.equal(acquireLock(file).owner, false)
})

test('release only removes our own lock', () => {
  const file = join(tmp(), 'auth.lock')
  writeFileSync(file, JSON.stringify({ pid: process.ppid }))
  releaseLock(file)
  assert.equal(acquireLock(file).owner, false)
})
