import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { defaultSettings, type ImagePreprocess } from '../../server/core/config'
import { resolvePreprocessOptions, runPreprocess } from '../../server/core/preprocess'
import { compressImage } from '../../server/core/preprocess/image'

const img = (w: number, h: number, fmt: 'png' | 'jpeg' = 'png', alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#884422' } })[fmt]().toBuffer()

const opts = (o: Partial<ImagePreprocess> = {}): ImagePreprocess => ({ enabled: true, maxEdge: 100, format: 'jpeg', quality: 80, ...o })

const chat = (...urls: unknown[]) => ({
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, ...urls.map(u => ({ type: 'image_url', image_url: { url: u } }))] },
  ],
})

const dataUri = (buf: Buffer, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`

describe('compressImage', () => {
  test('resizes the longest edge and re-encodes', async () => {
    const { out, report } = await compressImage(await img(400, 200), opts())
    expect(out).not.toBeNull()
    expect(report.before).toMatchObject({ width: 400, height: 200, format: 'png' })
    expect(report.after).toMatchObject({ width: 100, height: 50, format: 'jpeg' })
    const meta = await sharp(out!).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 100, 50])
  })

  test('small image already in the target format is kept as-is', async () => {
    const { out, report } = await compressImage(await img(50, 40, 'jpeg'), opts())
    expect(out).toBeNull()
    expect(report.after).toBeUndefined()
  })

  test('small image in another format is converted without enlarging; alpha flattened for jpeg', async () => {
    const { out } = await compressImage(await img(30, 20, 'png', true), opts())
    const meta = await sharp(out!).metadata()
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['jpeg', 30, 20, false])
  })
})

describe('runPreprocess', () => {
  test('rewrites data URIs, skips remote URLs, reports errors and keeps other content', async () => {
    const body = chat(dataUri(await img(300, 300)), 'https://example.com/a.png', 'data:image/png;base64,bm90IGFuIGltYWdl')
    const r = await runPreprocess(body, { options: { image: opts() } })
    expect(r.changed).toBe(true)
    const parts = (body.messages[1]!.content as any[])
    expect(parts[0]).toEqual({ type: 'text', text: 'look' })
    expect(parts[1].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(parts[2].image_url.url).toBe('https://example.com/a.png')
    expect(parts[3].image_url.url).toBe('data:image/png;base64,bm90IGFuIGltYWdl')
    expect(r.reports.image!.map(x => x.action)).toEqual(['compressed', 'skipped', 'error'])
  })

  test('string image_url and input_image parts', async () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUri(await img(200, 100)) }] }] }
    const r = await runPreprocess(body, { options: { image: opts({ format: 'webp' }) } })
    expect(r.changed).toBe(true)
    expect((body.messages[0]!.content[0] as any).image_url.startsWith('data:image/webp;base64,')).toBe(true)
  })

  test('disabled step and bodies without messages are untouched', async () => {
    const url = dataUri(await img(300, 300))
    const body = chat(url)
    const r = await runPreprocess(body, { options: { image: opts({ enabled: false }) } })
    expect(r.changed).toBe(false)
    expect((body.messages[1]!.content as any[])[1].image_url.url).toBe(url)
    expect((await runPreprocess({ prompt: 'x' }, { options: { image: opts() } })).changed).toBe(false)
  })
})

test('resolvePreprocessOptions: profile overrides the global image settings', () => {
  const g = defaultSettings().preprocess
  expect(resolvePreprocessOptions(g).image).toEqual(g.image)
  const o = resolvePreprocessOptions(g, { overrides: {}, extraArgs: '', preprocess: { image: { maxEdge: 1280, enabled: false } } })
  expect(o.image).toEqual({ ...g.image, maxEdge: 1280, enabled: false })
  expect(g.image.maxEdge).toBe(896)
})
