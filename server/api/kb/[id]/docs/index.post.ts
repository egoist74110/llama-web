// Add a document: { name, contentBase64, source?, mtime? } (.txt / .md, up to 50 MB). The management API takes JSON bodies
// only, so the file travels as base64. Answers as soon as the document is stored; embedding continues in the background.
import { getContext } from '../../../../service/context'
import { kbError } from '../../../../service/kb-api'
import { KbError } from '../../../../core/kb/errors'
import { MAX_UPLOAD_BYTES } from '../../../../core/kb/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  try {
    if (!body || typeof body !== 'object' || typeof body.name !== 'string' || typeof body.contentBase64 !== 'string') throw new KbError('bad-body')
    if (body.contentBase64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8) throw new KbError('too-large')
    const bytes = new Uint8Array(Buffer.from(body.contentBase64, 'base64'))
    return await getContext().kb.addDocument(getRouterParam(event, 'id') ?? '', {
      name: body.name,
      bytes,
      source: typeof body.source === 'string' ? body.source : undefined,
      mtime: typeof body.mtime === 'number' ? body.mtime : undefined,
    })
  } catch (e) {
    kbError(e)
  }
})
