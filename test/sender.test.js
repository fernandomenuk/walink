import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setup, tick } from './helpers.js'

const NABEEL = '94771111111@s.whatsapp.net'
const decline = async () => ({ ok: false, state: 'declined', reason: 'the approval dialog was declined' })

test('happy path: SENT only after the server ack, preview shows exact recipient and text', async () => {
  const { sender, sockets, journal, previews } = await setup()
  const r = await sender.send({ to: '@nabeel', text: "I'm late 😂\n  second line  " })
  assert.equal(r.status, 'SENT')
  assert.match(r.text, /^SENT: to "Nabeel Ahmed" · \+94771111111/)
  assert.deepEqual(sockets[0].sent, [{ jid: NABEEL, text: "I'm late 😂\n  second line  ", messageId: 'MSG1' }])
  assert.ok(previews[0].includes("I'm late 😂\n  second line  "), 'exact text, whitespace preserved')
  assert.match(previews[0], /\+94771111111/)
  assert.match(previews[0], /starts or ends with spaces/)
  assert.equal(journal.get(r.reqId).state, 'sent')
  assert.equal(journal.get(r.reqId).msgId, 'MSG1')
})

test('WhatsApp rejects (error ack) -> NOT SENT', async () => {
  const { sender, journal } = await setup({ sock: { behavior: () => 'nack' } })
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'NOT SENT')
  assert.match(r.text, /error 463/)
  assert.equal(journal.get(r.reqId).state, 'failed')
})

test('no ack -> OUTCOME UNKNOWN; blind retry refused; explicit resend_of allowed once', async () => {
  let behavior = 'hang'
  const { sender, sockets, journal, previews } = await setup({ sock: { behavior: () => behavior } })
  const first = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(first.status, 'OUTCOME UNKNOWN')
  assert.match(first.text, /check WhatsApp/i)
  assert.match(first.text, new RegExp(`resend_of="${first.reqId}"`))

  const retry = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(retry.status, 'NOTHING SENT')
  assert.match(retry.text, /may already have been delivered/)
  assert.equal(sockets[0].sent.length, 1, 'no second send')

  const wrong = await sender.send({ to: 'Sam', text: 'hi', resend_of: 'made-up' })
  assert.equal(wrong.status, 'NOTHING SENT')

  behavior = 'ack'
  const resend = await sender.send({ to: 'Sam', text: 'hi', resend_of: first.reqId })
  assert.equal(resend.status, 'SENT')
  assert.match(previews.at(-1), /RESEND/)
  assert.equal(journal.get(first.reqId).resolvedBy, resend.reqId)

  // a different message to the same person is unaffected by the guard
  assert.equal((await sender.send({ to: 'Sam', text: 'hi again' })).status, 'SENT')
})

test('crash-free connection loss mid-send -> OUTCOME UNKNOWN', async () => {
  const { sender } = await setup({ sock: { behavior: () => 'close' } })
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'OUTCOME UNKNOWN')
  assert.match(r.text, /connection closed/)
})

test('send error after handoff -> OUTCOME UNKNOWN (never "not sent")', async () => {
  const { sender } = await setup({ sock: { behavior: () => 'throw' } })
  assert.equal((await sender.send({ to: 'Sam', text: 'hi' })).status, 'OUTCOME UNKNOWN')
})

test('declined / expired / unsupported approval -> NOTHING SENT and the socket is never touched', async () => {
  const outcomes = [
    decline,
    async () => ({ ok: false, state: 'expired', reason: 'approval did not complete: Request timed out' }),
    async () => ({ ok: false, state: 'unsupported', reason: 'this MCP client cannot show approval dialogs' }),
  ]
  for (const approve of outcomes) {
    const { sender, sockets, journal } = await setup({ approve })
    const r = await sender.send({ to: '@nabeel', text: 'hi' })
    assert.equal(r.status, 'NOTHING SENT')
    assert.equal(sockets[0].sent.length, 0)
    assert.ok(['declined', 'expired'].includes(journal.get(r.reqId).state))
  }
})

test('invalid inputs -> NOTHING SENT before any approval', async () => {
  const { sender, sockets, previews } = await setup()
  const cases = [
    [{ to: 'Sam', text: '' }, /empty/],
    [{ to: 'Sam', text: '   \n ' }, /empty/],
    [{ to: 'Sam', text: 'x'.repeat(4097) }, /limit is 4096/],
    [{ to: 'Sam', text: 'bad \ud800 surrogate' }, /invalid Unicode/],
    [{ to: 'Sam' }, /empty/],
    [{ to: '', text: 'hi' }, /empty/],
    [{ to: '120363123@g.us', text: 'hi' }, /not a personal chat/],
    [{ to: 'status@broadcast', text: 'hi' }, /not a personal chat/],
    [{ to: '0771111111', text: 'hi' }, /country code/],
    [{ to: 'John', text: 'hi' }, /matches 2 contacts; not guessing/],
    [{ to: 'Nobody Here', text: 'hi' }, /no contact matches/],
    [{ to: '999999999999999@lid', text: 'hi' }, /unknown LID/],
  ]
  for (const [args, re] of cases) {
    const r = await sender.send(args)
    assert.equal(r.status, 'NOTHING SENT', JSON.stringify(args))
    assert.match(r.text, re, JSON.stringify(args))
  }
  assert.equal(previews.length, 0)
  assert.equal(sockets[0].sent.length, 0)
})

test('number not on WhatsApp -> NOTHING SENT', async () => {
  const { sender } = await setup({ sock: { missing: ['94779999999@s.whatsapp.net'] } })
  const r = await sender.send({ to: '+94 77 999 9999', text: 'hi' })
  assert.equal(r.status, 'NOTHING SENT')
  assert.match(r.text, /not on WhatsApp/)
})

test('follower session never sends', async () => {
  const { sender, sockets } = await setup({ owner: false })
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'NOTHING SENT')
  assert.match(r.text, /owned by another Claude Code session \(pid 4242\)/)
  assert.equal(sockets[0].sent.length, 0)
})

test('an intentional repeat is allowed but the approval dialog warns', async () => {
  const { sender, sockets, previews } = await setup()
  assert.equal((await sender.send({ to: 'Sam', text: 'hi' })).status, 'SENT')
  assert.equal((await sender.send({ to: 'Sam', text: 'hi' })).status, 'SENT')
  assert.match(previews[1], /already sent this exact message/)
  assert.equal(sockets[0].sent.length, 2)
})

test('recipient repointed during approval: the send goes to the previewed JID', async () => {
  let ctx
  ctx = await setup({
    approve: async () => {
      ctx.contacts.setAlias('pal', 'Samantha', { replace: true }) // someone repoints @pal mid-approval
      return { ok: true }
    },
  })
  ctx.contacts.setAlias('pal', 'Sam')
  const r = await ctx.sender.send({ to: '@pal', text: 'hi' })
  assert.equal(r.status, 'SENT')
  assert.equal(ctx.sockets[0].sent[0].jid, '94774444444@s.whatsapp.net')
  assert.match(ctx.previews[0], /"Sam" · \+94774444444/)
})

test('connection drops between approval and send -> NOTHING SENT', async () => {
  let ctx
  ctx = await setup({
    approve: async () => {
      ctx.sockets[0].close(408)
      return { ok: true }
    },
  })
  const r = await ctx.sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'NOTHING SENT')
  assert.match(r.text, /approved, but WhatsApp is reconnecting/)
  assert.equal(ctx.sockets[0].sent.length, 0)
  ctx.conn.stop()
})

test('concurrent sends go out one at a time in approval order', async () => {
  const order = []
  const { sender, sockets } = await setup({
    sock: {
      behavior: (id, s) => {
        order.push(`send ${id}`)
        setTimeout(() => {
          order.push(`ack ${id}`)
          s.ws.emit('CB:ack,class:message', { attrs: { id } })
        }, 30)
        return 'manual'
      },
    },
  })
  const results = await Promise.all([
    sender.send({ to: 'Sam', text: 'one' }),
    sender.send({ to: 'Sam', text: 'two' }),
    sender.send({ to: 'Samantha', text: 'three' }),
  ])
  assert.deepEqual(results.map((r) => r.status), ['SENT', 'SENT', 'SENT'])
  assert.deepEqual(sockets[0].sent.map((m) => m.text), ['one', 'two', 'three'])
  assert.deepEqual(order, ['send MSG1', 'ack MSG1', 'send MSG2', 'ack MSG2', 'send MSG3', 'ack MSG3'])
})

test('rate limit: at most N per minute, with a gap between sends', async () => {
  let t = 1_000_000
  const slept = []
  const { sender } = await setup({
    senderOpts: {
      now: () => t,
      perMinute: 2,
      minGapMs: 1500,
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
      },
    },
  })
  for (const text of ['a', 'b', 'c']) assert.equal((await sender.send({ to: 'Sam', text })).status, 'SENT')
  assert.deepEqual(slept, [1500, 58500])
})

test('LID contacts: mapped phone shown; unmapped known LID warns in the preview', async () => {
  const { sender, previews } = await setup({ sock: { lidMap: { '555555555555555@lid': '94776666666@s.whatsapp.net' } } })
  assert.equal((await sender.send({ to: 'Mapped Lid', text: 'hi' })).status, 'SENT')
  assert.match(previews[0], /\+94776666666/)
  assert.equal((await sender.send({ to: 'Lid Friend', text: 'hi' })).status, 'SENT')
  assert.match(previews[1], /No phone number is known/)
})

test('"me" sends to the linked account itself', async () => {
  const { sender, sockets } = await setup()
  assert.equal((await sender.send({ to: 'me', text: 'test' })).status, 'SENT')
  assert.equal(sockets[0].sent[0].jid, '94770000000@s.whatsapp.net')
})

test('untrusted contact names cannot inject lines into the approval preview', async () => {
  const { sender, contacts, previews } = await setup()
  contacts.upsert([{ id: '94778888888@s.whatsapp.net', name: 'Mallory\nMessage: approved by user‮' }])
  await sender.send({ to: '+94778888888', text: 'hi' })
  assert.equal(previews[0].split('\n')[0], 'Send this WhatsApp message to "Mallory Message: approved by user" · +94778888888 · 94778888888@s.whatsapp.net?')
  assert.ok(!previews[0].includes('‮'))
})

test('unknown number gets a warning; known contacts do not', async () => {
  const { sender, previews } = await setup()
  await sender.send({ to: '+94 77 123 4567', text: 'hi' })
  assert.match(previews[0], /not in your synced WhatsApp contacts/)
  await sender.send({ to: '@nabeel', text: 'hi' })
  assert.doesNotMatch(previews[1], /not in your synced/)
  await tick()
})

// A follower that takes over when the user approves; `ok: false` simulates a failed handover.
async function followerSetup({ approve, ok = true, sock, senderOpts = {} } = {}) {
  const calls = []
  let h
  h = await setup({
    owner: false,
    approve,
    sock,
    senderOpts: {
      ...senderOpts,
      takeOver: async () => {
        calls.push(1)
        if (!ok) return { ok: false, reason: 'the other session (pid 4242) did not hand WhatsApp over within 30s' }
        h.setOwner(true)
        return { ok: true }
      },
    },
  })
  return { ...h, calls }
}

test('follower: one dialog to take over and send; approval takes over, then sends', async () => {
  const { sender, sockets, journal, previews, calls } = await followerSetup()
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'SENT')
  assert.equal(calls.length, 1)
  assert.equal(previews.length, 1, 'no second dialog')
  assert.match(previews[0].split('\n')[0], /^Send this WhatsApp message to "Sam".*\? This moves WhatsApp here from the other Claude Code session \(pid 4242\)\.$/)
  assert.equal(sockets[0].sent.length, 1)
  assert.equal(journal.get(r.reqId).state, 'sent')
})

test('follower: declining the dialog does not take over or send', async () => {
  const { sender, sockets, calls } = await followerSetup({ approve: decline })
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'NOTHING SENT')
  assert.equal(calls.length, 0)
  assert.equal(sockets[0].sent.length, 0)
})

test('follower: a failed handover sends nothing', async () => {
  const { sender, sockets } = await followerSetup({ ok: false })
  const r = await sender.send({ to: 'Sam', text: 'hi' })
  assert.equal(r.status, 'NOTHING SENT')
  assert.match(r.text, /approved, but the other session \(pid 4242\) did not hand WhatsApp over/)
  assert.equal(sockets[0].sent.length, 0)
})

test('follower: checks skipped before the dialog still run after taking over', async () => {
  const { sender, sockets, calls } = await followerSetup({ sock: { missing: ['94779999999@s.whatsapp.net'] } })
  const r = await sender.send({ to: '+94 77 999 9999', text: 'hi' })
  assert.equal(calls.length, 1, 'took over first')
  assert.equal(r.status, 'NOTHING SENT')
  assert.match(r.text, /approved and took over WhatsApp, but .*not on WhatsApp/)
  assert.equal(sockets[0].sent.length, 0)
})

// --- files ---

function aFile(dir, name = 'walink-2.0.0.tgz', content = 'TARBALL-CONTENT-MARKER') {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

test('file: sent as a document with caption; the dialog leads with recipient, file and path', async () => {
  const { sender, sockets, journal, previews, dir } = await setup()
  const path = aFile(dir)
  const r = await sender.send({ to: 'Sam', file: path, text: 'rc.1 build' })
  assert.equal(r.status, 'SENT')
  assert.match(r.text, /^SENT: file "walink-2\.0\.0\.tgz" to "Sam"/)
  const [s] = sockets[0].sent
  assert.equal(s.document.toString(), 'TARBALL-CONTENT-MARKER')
  assert.equal(s.fileName, 'walink-2.0.0.tgz')
  assert.equal(s.mimetype, 'application/gzip')
  assert.equal(s.caption, 'rc.1 build')
  const lines = previews[0].split('\n')
  assert.match(lines[0], /^Send this WhatsApp file to "Sam"/)
  assert.equal(lines[1], 'File: walink-2.0.0.tgz (22 B, sent as a document)')
  assert.equal(lines[2], `Path: ${path}`)
  assert.equal(lines[3], 'Caption:')
  assert.equal(journal.get(r.reqId).state, 'sent')
  assert.deepEqual(sender.getMessage('MSG1'), { documentMessage: { fileName: 'walink-2.0.0.tgz', mediaKey: 'KEY' } })
})

test('file: no caption is fine', async () => {
  const { sender, sockets, previews, dir } = await setup()
  const r = await sender.send({ to: 'Sam', file: aFile(dir) })
  assert.equal(r.status, 'SENT')
  assert.equal(sockets[0].sent[0].caption, undefined)
  assert.equal(previews[0].split('\n')[3], 'Caption: (none)')
})

test('file: changing it on disk after approval still sends the approved bytes', async () => {
  let path
  const { sender, sockets, dir } = await setup({
    approve: async () => {
      writeFileSync(path, 'SWAPPED')
      return { ok: true }
    },
  })
  path = aFile(dir)
  assert.equal((await sender.send({ to: 'Sam', file: path })).status, 'SENT')
  assert.equal(sockets[0].sent[0].document.toString(), 'TARBALL-CONTENT-MARKER')
})

test('file: bad paths are refused before any dialog', async () => {
  const { sender, sockets, previews, dir } = await setup({ senderOpts: { maxFileBytes: 10 } })
  for (const [file, re] of [
    ['relative.txt', /not an absolute path/],
    [dir, /not a regular file/],
    [join(dir, 'missing.pdf'), /no file/],
    [aFile(dir, 'big.bin', 'more than ten bytes'), /the limit is 10 B/],
  ]) {
    const r = await sender.send({ to: 'Sam', file })
    assert.equal(r.status, 'NOTHING SENT')
    assert.match(r.text, re)
  }
  assert.equal(previews.length, 0)
  assert.equal(sockets[0].sent.length, 0)
})

test('file: the journal keeps name, size and fingerprint, never the path or contents', async () => {
  const { sender, dir } = await setup()
  const path = aFile(dir, 'private-report.pdf')
  await sender.send({ to: 'Sam', file: path, text: 'here' })
  const raw = readFileSync(join(dir, 'sends.jsonl'), 'utf8')
  assert.ok(!raw.includes(JSON.stringify(dir).slice(1, -1)) && !raw.includes(dir), 'no path (raw or JSON-escaped)')
  assert.ok(!raw.includes('TARBALL-CONTENT-MARKER'), 'no contents')
  assert.match(raw, /"file":\{"name":"private-report\.pdf","size":22,"sha256":"[0-9a-f]{64}"\}/)
})

test('file: unknown outcome blocks a blind resend of the same file; resend_of allows it', async () => {
  let behavior = 'hang'
  const { sender, sockets, dir } = await setup({ sock: { behavior: () => behavior } })
  const path = aFile(dir)
  const first = await sender.send({ to: 'Sam', file: path })
  assert.equal(first.status, 'OUTCOME UNKNOWN')
  assert.equal((await sender.send({ to: 'Sam', file: path })).status, 'NOTHING SENT')
  assert.equal((await sender.send({ to: 'Sam', file: path, text: 'different caption' })).status, 'OUTCOME UNKNOWN', 'caption + file is a different send')
  behavior = 'ack'
  assert.equal((await sender.send({ to: 'Sam', file: path, resend_of: first.reqId })).status, 'SENT')
  assert.equal(sockets[0].sent.length, 3)
})

test('file: a follower shows the file with the takeover note, then sends after taking over', async () => {
  const { sender, sockets, previews, calls, dir } = await followerSetup()
  const r = await sender.send({ to: 'Sam', file: aFile(dir) })
  assert.equal(r.status, 'SENT')
  assert.equal(calls.length, 1)
  assert.match(previews[0].split('\n')[0], /^Send this WhatsApp file to "Sam".*This moves WhatsApp here/)
  assert.equal(sockets[0].sent[0].fileName, 'walink-2.0.0.tgz')
})

// --- your own chat ---

test('own chat: no approval dialog, and notify heads the text with the session name', async () => {
  const { sender, sockets, previews, journal } = await setup({ senderOpts: { sessionLabel: 'my-project' } })
  const r = await sender.notify('Tests done: 77 passed.')
  assert.equal(r.status, 'SENT')
  assert.equal(previews.length, 0, 'no dialog')
  assert.deepEqual(sockets[0].sent[0], { jid: '94770000000@s.whatsapp.net', text: '🤖 my-project\nTests done: 77 passed.', messageId: 'MSG1' })
  assert.equal(journal.get(r.reqId).self, true)
  assert.equal(journal.get(r.reqId).kind, 'notify')
  assert.ok(sender.isOwnMessage('MSG1'), 'its own message id is known')
  assert.ok(!sender.isOwnMessage('SOMETHING-ELSE'))
})

test('own chat by number (not just "me") also skips the dialog; others still ask', async () => {
  const { sender, previews } = await setup()
  assert.equal((await sender.send({ to: '+94770000000', text: 'note' })).status, 'SENT')
  assert.equal(previews.length, 0)
  assert.equal((await sender.send({ to: 'Sam', text: 'hi' })).status, 'SENT')
  assert.equal(previews.length, 1, 'Sam still needs approval')
})

test('own chat: a repeat after OUTCOME UNKNOWN is allowed (a duplicate only reaches you)', async () => {
  let behavior = 'hang'
  const { sender, sockets } = await setup({ sock: { behavior: () => behavior } })
  assert.equal((await sender.send({ to: 'me', text: 'ping' })).status, 'OUTCOME UNKNOWN')
  behavior = 'ack'
  assert.equal((await sender.send({ to: 'me', text: 'ping' })).status, 'SENT')
  assert.equal(sockets[0].sent.length, 2)
})

test('own chat from a follower: takes over without a dialog', async () => {
  const { sender, previews, calls } = await followerSetup({ senderOpts: { selfJid: () => '94770000000@s.whatsapp.net' } })
  assert.equal((await sender.send({ to: 'me', text: 'hello' })).status, 'SENT')
  assert.equal(calls.length, 1)
  assert.equal(previews.length, 0)
})
