// Upstreams report model ids only (no type), so "is this a text chat model" is judged from the id:
// embedding, rerank, speech, image / video generation and moderation models cannot be chatted with.
const NON_TEXT = /embed|rerank|whisper|transcri|tts|speech|audio|dall-?e|gpt-image|image|imagen|flux|sdxl|stable-?diffusion|midjourney|sora|video|moderation|ocr|bge-|\bclip\b/i

export function isTextModelId(id: string): boolean {
  return !NON_TEXT.test(id)
}
