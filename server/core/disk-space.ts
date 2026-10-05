// Free disk space before a download (decision 44): at least three times the download (the archive, its unpacked copy
// and room to spare). Unknown free space never blocks.
import { existsSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'

export const DOWNLOAD_SPACE_FACTOR = 3

/** Free bytes on the disk holding `path` (or its nearest existing parent); null when it cannot be read. */
export function freeBytes(path: string): number | null {
  try {
    let dir = path
    while (!existsSync(dir)) {
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Bytes that must be free for a download of `size` bytes; null when the size is not known. */
export const neededBytes = (size: number | undefined | null): number | null =>
  typeof size === 'number' && Number.isFinite(size) && size > 0 ? size * DOWNLOAD_SPACE_FACTOR : null
