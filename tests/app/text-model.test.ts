import { expect, test } from 'bun:test'
import { isTextModelId } from '../../app/utils/text-model'

test('text models pass, other kinds are filtered', () => {
  for (const id of ['gpt-4o', 'qwen3-32b', 'deepseek-chat', 'claude-sonnet-5-5']) expect(isTextModelId(id)).toBe(true)
  for (const id of ['text-embedding-3-small', 'bge-m3', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-image-1', 'flux-dev', 'bge-reranker-v2']) expect(isTextModelId(id)).toBe(false)
})
