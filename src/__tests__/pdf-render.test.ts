// BASHSANDBOX1022: the dashboard-side PDF renderer for sandboxed agents (pdf-render.ts) and its
// route. The network test runs the REAL Chrome when it is installed: a page that names a local
// listening server must not reach it with the lockdown flags, and the same page without them must
// (the control that shows the test can fail).
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-pdf-render-test-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

vi.mock('../config.js', () => ({ STORE_DIR: join(tmpRoot, 'store'), PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'marveen' }))
const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))
vi.mock('../web/agent-config.js', () => ({ agentDir: (n: string) => join(tmpRoot, 'agents', n) }))

const { resolveRenderPaths, renderPdf, DEFAULT_CHROME_PATH } = await import('../web/pdf-render.js')
const { tryHandlePdfRender } = await import('../web/routes/pdf-render.js')

const root = join(tmpRoot, 'agents', 'soma')
const outside = join(tmpRoot, 'outside')
mkdirSync(join(root, 'out'), { recursive: true })
mkdirSync(outside, { recursive: true })
const page = join(root, 'out', 'r.html')
writeFileSync(page, '<!doctype html><meta charset="utf-8"><h1>Riport</h1><p>Árvíztűrő tükörfúrógép.</p>')

describe('resolveRenderPaths', () => {
  it('accepts an html and a pdf under a root', () => {
    expect(resolveRenderPaths([root], page, join(root, 'out', 'r.pdf'))).toEqual({ html: expect.stringMatching(/r\.html$/), pdf: expect.stringMatching(/r\.pdf$/) })
  })
  it('refuses relative, non-html, non-pdf, missing and outside paths', () => {
    const bad: Array<[unknown, unknown, RegExp]> = [
      ['out/r.html', join(root, 'r.pdf'), /absolute/],
      [join(root, 'out', 'r.txt'), join(root, 'r.pdf'), /\.html/],
      [page, join(root, 'r.png'), /\.pdf/],
      [join(root, 'nope.html'), join(root, 'r.pdf'), /not an existing file/],
      [page, join(outside, 'r.pdf'), /outside/],
      [page, join(root, 'missing-dir', 'r.pdf'), /does not exist/],
      [42, join(root, 'r.pdf'), /strings/],
    ]
    for (const [h, p, rx] of bad) expect(resolveRenderPaths([root], h, p)).toEqual({ error: expect.stringMatching(rx) })
  })
  it('a symlink cannot walk out: neither an html linked from outside nor an output dir or file link', () => {
    const secret = join(outside, 's.html'); writeFileSync(secret, '<p>x</p>')
    symlinkSync(secret, join(root, 'link.html'))
    expect(resolveRenderPaths([root], join(root, 'link.html'), join(root, 'r.pdf'))).toEqual({ error: expect.stringMatching(/outside/) })
    symlinkSync(outside, join(root, 'linkdir'))
    expect(resolveRenderPaths([root], page, join(root, 'linkdir', 'r.pdf'))).toEqual({ error: expect.stringMatching(/outside/) })
    symlinkSync(join(outside, 'target.pdf'), join(root, 'out', 'l.pdf'))
    expect(resolveRenderPaths([root], page, join(root, 'out', 'l.pdf'))).toEqual({ error: expect.stringMatching(/not a regular file/) })
  })
})

const hasChrome = existsSync(DEFAULT_CHROME_PATH)
describe.skipIf(!hasChrome)('renderPdf with the real Chrome', () => {
  async function withServer(fn: (port: number, hits: string[]) => Promise<void>): Promise<void> {
    const hits: string[] = []
    const srv = http.createServer((req, res) => { hits.push(req.url ?? ''); res.end('x') })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try { await fn((srv.address() as AddressInfo).port, hits) } finally { await new Promise((r) => srv.close(r)) }
  }
  const probePage = (port: number) => `<!doctype html><meta charset="utf-8"><h1>PDF</h1>
<img src="http://127.0.0.1:${port}/img-ip.png"><img src="http://localhost:${port}/img-name.png">
<link rel="stylesheet" href="http://127.0.0.1:${port}/style.css">
<script>fetch('http://127.0.0.1:${port}/js')</script>`

  it('renders the PDF and the page reaches nothing; without the lockdown the same page does (control)', async () => {
    await withServer(async (port, hits) => {
      const html = join(root, 'out', 'net.html'); writeFileSync(html, probePage(port))
      const pdf = join(root, 'out', 'net.pdf')
      const r = await renderPdf(html, pdf)
      expect(r).toMatchObject({ ok: true })
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
      expect(hits).toEqual([])
      const c = await renderPdf(html, join(root, 'out', 'control.pdf'), { lockdown: false })
      expect(c).toMatchObject({ ok: true })
      expect(hits.length).toBeGreaterThan(0)
    })
  }, 120_000)
})

function fakeCtx(method: string, body: string) {
  const req = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage
  const out: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {}, getHeader() { return undefined },
    end(b?: string) { try { out.body = JSON.parse(String(b)) } catch { out.body = b } },
  } as unknown as http.ServerResponse
  return { ctx: { req, res, path: '/api/pdf/render', method, url: new URL('http://x/api/pdf/render') }, out }
}

describe('POST /api/pdf/render', () => {
  it('refuses an agent that is not on BASH_SANDBOX_AGENTS (the field is self-declared, it grants nothing else)', async () => {
    const { ctx, out } = fakeCtx('POST', JSON.stringify({ agent: 'soma', html_path: page, pdf_path: join(root, 'out', 'r.pdf') }))
    expect(await tryHandlePdfRender(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })
  it('a listed agent: unknown fields and paths outside its roots are 400', async () => {
    settings.BASH_SANDBOX_AGENTS = 'soma'
    let t = fakeCtx('POST', JSON.stringify({ agent: 'soma', html_path: page, pdf_path: join(root, 'r.pdf'), chrome_args: ['--x'] }))
    await tryHandlePdfRender(t.ctx); expect(t.out.status).toBe(400)
    t = fakeCtx('POST', JSON.stringify({ agent: 'soma', html_path: page, pdf_path: join(outside, 'r.pdf') }))
    await tryHandlePdfRender(t.ctx); expect(t.out).toMatchObject({ status: 400, body: { error: expect.stringMatching(/outside/) } })
    t = fakeCtx('POST', 'x'.repeat(9000))
    await tryHandlePdfRender(t.ctx); expect(t.out.status).toBe(400)
    t = fakeCtx('GET', '')
    await tryHandlePdfRender(t.ctx); expect(t.out.status).toBe(405)
  })
  it('ignores other paths', async () => {
    const { ctx } = fakeCtx('POST', '{}')
    expect(await tryHandlePdfRender({ ...ctx, path: '/api/pdf/other' })).toBe(false)
  })
})
