// Text decoding for imports (decision 65 ③): UTF-8 (with or without BOM), UTF-16 by BOM, and GB18030 for what is not
// valid UTF-8 (the usual encoding of Chinese .txt files). Line breaks are normalised to \n.
import { KbError } from './errors'

export interface Decoded {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
}

function swap16(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2))
  for (let i = 0; i < out.length; i += 2) {
    out[i] = bytes[i + 1]!
    out[i + 1] = bytes[i]!
  }
  return out
}

/** Decode a text file's bytes. Throws KbError('not-text') for binary data and KbError('decode-failed') when no decoder works. */
export function decodeText(bytes: Uint8Array): Decoded {
  let text: string
  let encoding: Decoded['encoding']
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(bytes.subarray(3))
    encoding = 'utf-8'
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
    encoding = 'utf-16le'
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16le').decode(swap16(bytes.subarray(2)))
    encoding = 'utf-16be'
  } else {
    // NUL bytes in the first 8 KB: a binary file (UTF-16 without a BOM is not guessed).
    const head = bytes.subarray(0, 8192)
    if (head.includes(0)) throw new KbError('not-text')
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      encoding = 'utf-8'
    } catch {
      try {
        text = new TextDecoder('gb18030').decode(bytes)
        encoding = 'gb18030'
      } catch (e) {
        throw new KbError('decode-failed', (e as Error).message)
      }
    }
  }
  text = text.replace(/\r\n?/g, '\n')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, encoding }
}
