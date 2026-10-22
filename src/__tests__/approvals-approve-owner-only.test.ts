// Kanban 80d0e3c6: approving is the owner's decision. Measured before this fix, with the real route
// and then the REAL email-approval-gate.py, from a caller holding the shared dashboard token (which
// every agent holds):
//   1. POST naming the main agent + owner_approved_message_id -> a row born approved -> the gate let
//      the matching letter through;
//   2. a pending row under the caller's own name, then PATCH status=approved with a made-up
//      resolved_by -> approved -> the gate let the letter through;
//   3. the same born-approved POST for STANDING_CATEGORY (email_standing_recipient) -> every later
//      letter to that address went out with no approval at all.
// Approving (the born-approved POST and PATCH status=approved) now takes an owner credential: a
// dashboard login session or a full-scope device key. Reject and timeout stay open to the token:
// with them an agent can only cancel a request, never gain a right.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sendSpy = vi.hoisted(() => vi.fn(async () => 4242))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }))
vi.mock('../owner-chat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777' }))
vi.mock('../web/telegram.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../web/telegram.js')>()), sendTelegramMessage: sendSpy }))

import { initDatabase, getApproval, listApprovals } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

const td = mkdtempSync(join(tmpdir(), 'approvals-owner-only-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))
const store = join(td, 'store'); mkdirSync(store, { recursive: true })
writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false }] }))
initDatabase(join(store, 'claudeclaw.db'))

type Auth = { kind: 'token' | 'session' | 'device'; agent?: string; user?: string; scope?: 'full' | 'operator' }
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const OWNER: Auth = { kind: 'session', user: 'owner' }

const GATE = join(process.cwd(), 'scripts', 'hooks', 'email-approval-gate.py')
let letterNo = 0
function letter(to = 'idegen@pelda.hu') {
  letterNo++
  return { tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: [to], subject: `Teszt ${letterNo}`, body: `Kedves Ügyfelünk! Ez a(z) ${letterNo}. mérés.` } }
}
function gate(payload: unknown) {
  const r = spawnSync('python3', [GATE], { input: JSON.stringify(payload), env: { ...process.env, EMAIL_APPROVAL_GATE_STORE: store, OUTGOING_COPY_GATE_RULES: join(store, 'no-rules.json') }, encoding: 'utf-8' })
  return { code: r.status, err: r.stderr }
}
// The gate's first deny names the anchor an approval must carry for exactly this letter.
function anchorOf(payload: unknown): string {
  const g = gate(payload)
  expect(g.code).toBe(2)
  const a = (g.err.match(/[0-9a-f]{64}/) ?? [])[0]
  expect(a).toBeTruthy()
  return a as string
}

async function call(method: 'POST' | 'PATCH', path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = JSON.stringify(body)
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleApprovals({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  await new Promise((r) => setImmediate(r))
  return out
}
const post = (body: unknown, auth: Auth) => call('POST', '/api/approvals', body, auth)
const patch = (id: string, body: unknown, auth: Auth) => call('PATCH', `/api/approvals/${id}`, body, auth)

describe('born-approved POST (owner_approved_message_id)', () => {
  it('the shared token naming the main agent is 403, no row is written, and the gate stays shut', async () => {
    const p = letter()
    const anchor = anchorOf(p)
    const before = listApprovals({ limit: 500 }).length
    const r = await post({ agent_id: 'marveen', category: 'email_send', action_description: 'x', content_hash: anchor, owner_approved_message_id: 1 }, TOKEN)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/owner/)
    expect(listApprovals({ limit: 500 }).length).toBe(before)
    expect(gate(p).code).toBe(2)
  })

  it('POSITIVE CONTROL: the owner session files it born approved, and the gate opens for that letter', async () => {
    const p = letter()
    const anchor = anchorOf(p)
    const r = await post({ agent_id: 'marveen', category: 'email_send', action_description: 'x', content_hash: anchor, owner_approved_message_id: 2 }, OWNER)
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('approved')
    expect(gate(p).code).toBe(0)
  })

  it('a plain request (no owner field) still opens with the token: asking is not approving', async () => {
    const r = await post({ agent_id: 'soma', category: 'email_send', action_description: 'x' }, TOKEN)
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
  })
})

describe('PATCH status=approved', () => {
  it('the token approving a pending row is 403: the row stays pending and the gate stays shut', async () => {
    const p = letter()
    const anchor = anchorOf(p)
    const own = await post({ agent_id: 'soma', category: 'email_send', action_description: 'y', content_hash: anchor }, TOKEN)
    expect(own.status).toBe(201)
    const r = await patch(own.body.id, { status: 'approved', resolved_by: 'telegram_text' }, TOKEN)
    expect(r.status).toBe(403)
    expect(getApproval(own.body.id)?.status).toBe('pending')
    expect(gate(p).code).toBe(2)
  })

  it('an operator-scope device key is a limited key and is refused as well', async () => {
    const own = await post({ agent_id: 'soma', category: 'email_send', action_description: 'z' }, TOKEN)
    expect((await patch(own.body.id, { status: 'approved', resolved_by: 'dashboard' }, { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect(getApproval(own.body.id)?.status).toBe('pending')
  })

  it('POSITIVE CONTROL: the owner session approves, and the gate opens for that letter', async () => {
    const p = letter()
    const anchor = anchorOf(p)
    const own = await post({ agent_id: 'soma', category: 'email_send', action_description: 'w', content_hash: anchor }, TOKEN)
    const r = await patch(own.body.id, { status: 'approved', resolved_by: 'dashboard' }, OWNER)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('approved')
    expect(gate(p).code).toBe(0)
  })

  it('POSITIVE CONTROL: a full-scope device key approves', async () => {
    const own = await post({ agent_id: 'soma', category: 'email_send', action_description: 'v' }, TOKEN)
    expect((await patch(own.body.id, { status: 'approved', resolved_by: 'dashboard' }, { kind: 'device', scope: 'full' })).status).toBe(200)
  })

  it.each(['rejected', 'timeout'])('the token may still resolve a request as %s: that only cancels it', async (status) => {
    const own = await post({ agent_id: 'soma', category: 'email_send', action_description: status }, TOKEN)
    const r = await patch(own.body.id, { status, resolved_by: 'marveen' }, TOKEN)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe(status)
  })
})

describe('standing-recipient activation (STANDING_CATEGORY)', () => {
  const addr = 'allando@pelda.hu'
  const anchor = createHash('sha256').update(addr).digest('hex')

  it('the token cannot activate a listed address: neither born approved nor by PATCH, and letters stay gated', async () => {
    writeFileSync(join(store, 'email-standing-recipients.json'), JSON.stringify({ recipients: [addr] }))
    const first = gate(letter(addr))
    expect(first.code).toBe(2)
    expect(first.err).toMatch(/NINCS ELESITVE/)
    const spoof = await post({ agent_id: 'marveen', category: 'email_standing_recipient', action_description: 'Allando cimzett elesitese', content_hash: anchor, owner_approved_message_id: 3 }, TOKEN)
    expect(spoof.status).toBe(403)
    const pending = await post({ agent_id: 'soma', category: 'email_standing_recipient', action_description: 'Allando cimzett elesitese', content_hash: anchor }, TOKEN)
    expect((await patch(pending.body.id, { status: 'approved', resolved_by: 'telegram_text' }, TOKEN)).status).toBe(403)
    expect(gate(letter(addr)).code).toBe(2)
    expect(gate(letter(addr)).code).toBe(2)
    // tidy: the pending row must not answer the owner-control test below
    expect((await patch(pending.body.id, { status: 'rejected', resolved_by: 'test' }, TOKEN)).status).toBe(200)
  })

  it('POSITIVE CONTROL: the owner session activates it, and later letters to it pass', async () => {
    const r = await post({ agent_id: 'marveen', category: 'email_standing_recipient', action_description: 'Allando cimzett elesitese', content_hash: anchor, owner_approved_message_id: 4 }, OWNER)
    expect(r.status).toBe(201)
    expect(gate(letter(addr)).code).toBe(0)
    expect(gate(letter(addr)).code).toBe(0)
  })
})
