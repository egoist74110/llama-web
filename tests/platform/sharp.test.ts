// Platform check: sharp must load and work under Bun on Windows (plan: tech validation).
import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'

describe('sharp under bun', () => {
  test('resizes a large image to maxEdge and encodes jpeg', async () => {
    const src = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().toBuffer()

    const out = await sharp(src)
      .resize({ width: 896, height: 896, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true })

    expect(out.info.format).toBe('jpeg')
    expect(out.info.width).toBe(896)
    expect(out.info.height).toBe(597)
  })

  test('decodes webp and gif input', async () => {
    const webp = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#00ff0080' } }).webp().toBuffer()
    const gif = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#0000ff' } }).gif().toBuffer()
    expect((await sharp(webp).metadata()).format).toBe('webp')
    expect((await sharp(gif).metadata()).format).toBe('gif')
  })
})
