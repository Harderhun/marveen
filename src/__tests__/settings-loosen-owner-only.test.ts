// BASHSANDBOX1022 security review of #2149: a sandboxed agent reaches the dashboard on localhost with
// the shared fleet token, so through POST /api/settings it could take itself off BASH_SANDBOX_AGENTS.
// A setting whose registry entry says a change LOOSENS it accepts that change only from an owner
// session or a full-scope device key; tightening (adding an agent) stays open to every caller.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  getEffectiveSettingSource: (k: string) => ({ value: settings.get(k) ?? '', source: settings.has(k) ? 'override' : 'default' }),
  getSettingFallback: () => ({ value: '', source: 'default' }),
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
  clearOverride: (k: string) => { const had = settings.delete(k); return { ok: true, removed: had } },
}))
vi.mock('../db.js', () => ({ logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => {} }))

const { tryHandleSettings } = await import('../web/routes/settings.js')
const { SETTINGS_REGISTRY } = await import('../config-registry.js')

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; user?: string }
async function call(method: 'POST' | 'DELETE', path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSettings({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const set = (value: string, auth: Auth) => call('POST', '/api/settings', { key: 'BASH_SANDBOX_AGENTS', value }, auth)

describe('BASH_SANDBOX_AGENTS: the shared token may tighten it, never loosen it', () => {
  beforeEach(() => { settings.clear() })

  it('the token may add agents', async () => {
    expect((await set('soma', { kind: 'token' })).status).toBe(200)
    expect((await set('soma, trinity', { kind: 'token' })).status).toBe(200)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('the token may not take an agent off, by POST or by reset; the value stays', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    const r = await set('trinity', { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/owner session or a full-scope device key/)
    expect((await set('', { kind: 'token' })).status).toBe(403)
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, { kind: 'token' })).status).toBe(403)
    expect((await set('trinity', { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('an owner session or a full device key may loosen it', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'session', user: 'owner' })).status).toBe(200)
    expect((await set('', { kind: 'device', scope: 'full' })).status).toBe(200)
    settings.set('BASH_SANDBOX_AGENTS', 'soma')
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, { kind: 'session', user: 'owner' })).status).toBe(200)
  })

  it('the loosens rule: removal loosens, reordering, spacing and case do not', () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'BASH_SANDBOX_AGENTS')!
    expect(def.loosens?.('soma, trinity', 'trinity')).toBe(true)
    expect(def.loosens?.('soma', '')).toBe(true)
    expect(def.loosens?.('soma', 'Trinity  SOMA')).toBe(false)
    expect(def.loosens?.('', 'soma')).toBe(false)
  })
})
