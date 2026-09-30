// Image compression step: shrink base64 data-URI images in chat messages so the longest edge
// is at most `maxEdge`, re-encoding to the configured format. Remote URLs are left alone.
import sharp from 'sharp'
import type { ImagePreprocess } from '../config'
import type { PreprocessStep } from './index'

export interface ImageReport {
  /** Index of the message and content part. */
  message: number
  part: number
  action: 'compressed' | 'kept' | 'skipped' | 'error'
  before?: { width: number, height: number, bytes: number, format: string }
  after?: { width: number, height: number, bytes: number, format: string }
  detail?: string
}

const DATA_URI = /^data:([^;,]+)?(;[^,]*)?,/

function decodeDataUri(uri: string): Buffer | null {
  const m = DATA_URI.exec(uri)
  if (!m || !(m[2] ?? '').includes(';base64')) return null
  return Buffer.from(uri.slice(m[0].length), 'base64')
}

const MIME: Record<ImagePreprocess['format'], string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export async function compressImage(input: Buffer, opts: ImagePreprocess): Promise<{ out: Buffer | null, report: Pick<ImageReport, 'before' | 'after'> }> {
  const meta = await sharp(input).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const before = { width, height, bytes: input.length, format: meta.format ?? 'unknown' }
  const tooBig = Math.max(width, height) > opts.maxEdge
  // Already small and in the target format: forward untouched.
  if (!tooBig && meta.format === opts.format) return { out: null, report: { before } }

  let img = sharp(input).rotate() // honour EXIF orientation before resizing
  if (tooBig) img = img.resize({ width: opts.maxEdge, height: opts.maxEdge, fit: 'inside', withoutEnlargement: true })
  if (opts.format === 'jpeg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality: opts.quality })
  else if (opts.format === 'webp') img = img.webp({ quality: opts.quality })
  else img = img.png()
  const { data, info } = await img.toBuffer({ resolveWithObject: true })
  return { out: data, report: { before, after: { width: info.width, height: info.height, bytes: data.length, format: opts.format } } }
}

export const imageStep: PreprocessStep<ImageReport> = {
  name: 'image',
  async run(body, ctx) {
    const opts = ctx.options.image
    const reports: ImageReport[] = []
    const messages = (body as any)?.messages
    if (!opts.enabled || !Array.isArray(messages)) return { changed: false, reports }
    let changed = false
    for (let mi = 0; mi < messages.length; mi++) {
      const content = messages[mi]?.content
      if (!Array.isArray(content)) continue
      for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi]
        if (part?.type !== 'image_url' && part?.type !== 'input_image') continue
        const holder = typeof part.image_url === 'string' ? part : part.image_url
        const key = typeof part.image_url === 'string' ? 'image_url' : 'url'
        const url = holder?.[key]
        const buf = typeof url === 'string' ? decodeDataUri(url) : null
        if (!buf) {
          reports.push({ message: mi, part: pi, action: 'skipped', detail: 'not a base64 data URI' })
          continue
        }
        try {
          const { out, report } = await compressImage(buf, opts)
          if (out) {
            holder[key] = `data:${MIME[opts.format]};base64,${out.toString('base64')}`
            changed = true
            reports.push({ message: mi, part: pi, action: 'compressed', ...report })
          } else {
            reports.push({ message: mi, part: pi, action: 'kept', ...report })
          }
        } catch (e) {
          // Undecodable image: forward as-is and let llama-server report it.
          reports.push({ message: mi, part: pi, action: 'error', detail: (e as Error).message })
        }
      }
    }
    return { changed, reports }
  },
}
