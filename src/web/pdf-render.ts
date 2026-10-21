// BASHSANDBOX1022: headless Chrome cannot run inside Claude Code's Bash sandbox. Measured on the
// 2.1.306 Seatbelt profile: past the crashpad and ProcessSingleton denials (which allowWrite on the
// user temp dir plus allowUnixSockets get through) Chrome dies on a CHECK in base/mac/mac_util.mm,
// because the profile allows only a fixed list of sysctl names (hw.model, kern.hv_vmm_present,
// kern.boottime and 8 more read EPERM in the sandbox and fine on the host) and no setting widens it.
// A sandboxed agent's report PDF is therefore rendered HERE, by the dashboard, outside the sandbox
// -- and narrowly, so this does not become the network route the sandbox closed:
//   - only an existing .html file in, only a .pdf out, both under the agent's sandbox write roots
//     (realpath'd, so a symlink cannot walk out), size- and time-limited;
//   - a fixed argv, no shell, a throwaway profile;
//   - the network shut for the render: every request goes to a dead proxy on 127.0.0.1:9 with
//     loopback included (<-loopback>), every hostname resolves to NOTFOUND, and non-proxied WebRTC
//     UDP is off. Scripts DO run: --blink-settings=scriptEnabled=false made --print-to-pdf exit 0
//     without writing a PDF (Chrome 155, measured), so the page's own fetch() is shut by the same
//     network flags instead. The test renders a page whose images, stylesheet and script all name a
//     local listening server and shows it receives nothing -- and that without these flags it does.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const MAX_HTML_BYTES = 10 * 1024 * 1024
export const MAX_PDF_BYTES = 50 * 1024 * 1024
export const RENDER_TIMEOUT_MS = 90_000

export const NETWORK_LOCKDOWN_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
]

export function chromeArgs(profileDir: string, pdfOut: string, html: string, lockdown = true): string[] {
  return [
    '--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${profileDir}`,
    ...(lockdown ? NETWORK_LOCKDOWN_ARGS : []),
    `--print-to-pdf=${pdfOut}`, html,
  ]
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}
function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

export type RenderPaths = { html: string; pdf: string } | { error: string }

// Both paths must be absolute and land, after symlinks are resolved, under one of the roots. The
// output may not be an existing symlink or directory: it is written by rename, never through a link.
export function resolveRenderPaths(roots: string[], htmlPath: unknown, pdfPath: unknown): RenderPaths {
  if (typeof htmlPath !== 'string' || typeof pdfPath !== 'string') return { error: 'html_path and pdf_path must be strings' }
  if (htmlPath.includes('\0') || pdfPath.includes('\0') || !isAbsolute(htmlPath) || !isAbsolute(pdfPath)) return { error: 'html_path and pdf_path must be absolute paths' }
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null)
  if (!realRoots.length) return { error: 'the agent has no existing write root' }
  if (!/\.html?$/i.test(htmlPath)) return { error: 'html_path must end in .html or .htm' }
  const html = realOrNull(htmlPath)
  if (!html || !statSync(html).isFile()) return { error: 'html_path is not an existing file' }
  if (!realRoots.some((r) => inside(html, r))) return { error: 'html_path is outside the agent\'s write roots' }
  if (statSync(html).size > MAX_HTML_BYTES) return { error: `html_path is larger than ${MAX_HTML_BYTES} bytes` }
  if (!/\.pdf$/i.test(pdfPath)) return { error: 'pdf_path must end in .pdf' }
  const dir = realOrNull(dirname(pdfPath))
  if (!dir || !statSync(dir).isDirectory()) return { error: 'the directory of pdf_path does not exist' }
  if (!realRoots.some((r) => inside(dir, r))) return { error: 'pdf_path is outside the agent\'s write roots' }
  const pdf = join(dir, basename(pdfPath))
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(pdf) } catch { /* a new file */ }
  if (existing && !existing.isFile()) return { error: 'pdf_path exists and is not a regular file' }
  return { html, pdf }
}

let running = 0
export const MAX_CONCURRENT_RENDERS = 2

// Renders html into a private temp dir, then moves the PDF into place with an atomic write. Resolves
// with the byte count, or an error message; never throws.
export function renderPdf(html: string, pdf: string, opts: { chrome?: string; timeoutMs?: number; lockdown?: boolean } = {}): Promise<{ ok: true; bytes: number } | { ok: false; error: string; busy?: boolean }> {
  const chrome = opts.chrome ?? DEFAULT_CHROME_PATH
  if (!existsSync(chrome)) return Promise.resolve({ ok: false, error: `Chrome not found at ${chrome}` })
  if (running >= MAX_CONCURRENT_RENDERS) return Promise.resolve({ ok: false, error: 'renderer busy, retry shortly', busy: true })
  running++
  const work = mkdtempSync(join(tmpdir(), 'marveen-pdf-'))
  const out = join(work, 'out.pdf')
  return new Promise((resolve) => {
    execFile(chrome, chromeArgs(join(work, 'profile'), out, html, opts.lockdown ?? true),
      { timeout: opts.timeoutMs ?? RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, _stdout, stderr) => {
        try {
          if (!existsSync(out)) {
            resolve({ ok: false, error: `Chrome produced no PDF (${err ? (err.killed ? 'timed out' : `exit ${err.code ?? '?'}`) : 'exit 0'}): ${String(stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` })
            return
          }
          const size = statSync(out).size
          if (size > MAX_PDF_BYTES) { resolve({ ok: false, error: `the PDF is larger than ${MAX_PDF_BYTES} bytes` }); return }
          atomicWriteFileSync(pdf, readFileSync(out))
          resolve({ ok: true, bytes: size })
        } catch (e) {
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
        } finally {
          running--
          rmSync(work, { recursive: true, force: true })
        }
      })
  })
}
