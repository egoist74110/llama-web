// Fake GitHub Releases for the llama.cpp download / update tests: routes by URL and records requests.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const EXE = 'llama-server.exe'
export const sha = (b: string) => createHash('sha256').update(b).digest('hex')

export interface FakeOpts {
  tag?: string
  bodies?: Record<string, string>
  digests?: Record<string, string | null>
  omit?: string[]
  /** Requests whose URL contains this text throw (offline). */
  fail?: string
  /** Called before each download is answered (lets a test act "during" a download). */
  onDownload?: (name: string) => void | Promise<void>
}

export function fakeGithub(o: FakeOpts = {}) {
  const tag = o.tag ?? 'b1234'
  const binName = `llama-${tag}-bin-win-cuda-13.3-x64.zip`
  const dllName = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  const bodies: Record<string, string> = { [binName]: 'BIN-ZIP', [dllName]: 'DLL-ZIP', ...o.bodies }
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://dl.test/${name}`,
    digest: name in (o.digests ?? {}) ? o.digests![name] : `sha256:${sha(bodies[name] ?? '')}`,
  })
  const calls: string[] = []
  const fetchFn = async (url: string) => {
    calls.push(url)
    if (o.fail && url.includes(o.fail)) throw new Error('offline')
    if (url.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://dl.test/nightly-tag.txt' }] })
    if (url === 'https://dl.test/nightly-tag.txt') return new Response(`${tag}\n`)
    if (url.endsWith(`/releases/tags/${tag}`)) return Response.json({ assets: [binName, dllName].filter(n => !o.omit?.includes(n)).map(asset) })
    const name = url.replace('https://dl.test/', '')
    if (name in bodies) {
      await o.onDownload?.(name)
      return new Response(bodies[name])
    }
    return new Response('nope', { status: 404 })
  }
  const downloads = () => calls.filter(c => c.startsWith('https://dl.test/') && c.endsWith('.zip'))
  return { fetchFn, calls, downloads, binName, dllName, tag }
}

/** Extract stub: bin zip yields the exe, cudart zip yields a dll. */
export const fakeExtract = (root = '') => async (zip: string, dest: string) => {
  const dir = join(dest, root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, zip.includes('cudart') ? 'cudart64_13.dll' : EXE), 'x')
}
