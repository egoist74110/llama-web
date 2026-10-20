// Management API helpers for the embedding engine (decision 64).
import { scanModelDirs } from '../core/scanner'
import { EmbeddingError } from '../core/embedding'
import { fmt, t } from '../core/i18n'
import { StoreError } from '../core/store'
import { getContext } from './context'

/** llama.cpp pooling types of embedding models (1 mean, 2 cls, 3 last); 4 (rank) is a reranker. */
const EMBEDDING_POOLING = new Set([1, 2, 3])

/** Saved configuration, engine state and the embedding GGUF files found in the model directories. */
export async function describeEmbedding(opts: { scan?: boolean } = {}) {
  const ctx = getContext()
  const config = ctx.getEmbedding()
  let candidates: Array<{ ref: { dirId: string, rel: string }, fileName: string, size: number, name: string | null, quantization: string | null, contextLength: number | null, dims: number | null, pooling: number | null }> | null = null
  if (opts.scan !== false) {
    const { entries } = await scanModelDirs(ctx.getSettings().modelDirs)
    candidates = entries
      .filter(e => e.kind === 'model' && e.complete && e.meta && e.meta.poolingType !== 4
        && (EMBEDDING_POOLING.has(e.meta.poolingType ?? -1) || /embed/i.test(e.fileName)))
      .map(e => ({
        ref: e.ref, fileName: e.fileName, size: e.size, name: e.meta!.name, quantization: e.meta!.quantization,
        contextLength: e.meta!.contextLength, dims: e.meta!.arch.embeddingLength, pooling: e.meta!.poolingType,
      }))
  }
  return { config, status: ctx.embedding.view(), candidates }
}

/** Turn an EmbeddingError into an HTTP error with a message in the interface language; other errors pass through. */
export function embeddingError(e: unknown): never {
  if (e instanceof EmbeddingError) {
    const errors = t.embedding.errors as Record<string, string>
    throw createError({ statusCode: e.code === 'name-local-conflict' ? 409 : 400, message: fmt(errors[e.code] ?? e.code, { detail: e.message }) })
  }
  if (e instanceof StoreError) throw createError({ statusCode: 409, message: fmt(t.embedding.errors.store, { detail: e.message }) })
  throw e
}
