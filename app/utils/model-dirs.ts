// Checks for the "Add folder" button on the models page: is the new folder already a model
// directory, or already covered by one? Pure; the server still does the authoritative duplicate check.

export interface DirLike {
  path: string
  enabled: boolean
  maxDepth: number
}

export type NewDirCheck =
  | { kind: 'ok' }
  | { kind: 'duplicate', path: string }
  | { kind: 'inside', path: string, depth: number }

/** Strip quotes / trailing separators and unify slashes; case-insensitive on Windows. */
export function dirKey(path: string, windows: boolean): string {
  const p = path.trim().replace(/^"(.*)"$/, '$1').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? p.toLowerCase() : p
}

/**
 * `duplicate`: same folder as an existing row. `inside`: below an enabled row, within its scan depth,
 * so a scan already sees it. A subfolder deeper than the depth (or under a disabled row) is `ok`.
 */
export function checkNewDir(existing: DirLike[], path: string, windows: boolean): NewDirCheck {
  const key = dirKey(path, windows)
  for (const d of existing) {
    if (dirKey(d.path, windows) === key) return { kind: 'duplicate', path: d.path }
  }
  for (const d of existing) {
    if (!d.enabled) continue
    const root = dirKey(d.path, windows)
    if (!root || !key.startsWith(`${root}/`)) continue
    const levels = key.slice(root.length + 1).split('/').filter(Boolean).length
    if (levels <= d.maxDepth) return { kind: 'inside', path: d.path, depth: d.maxDepth }
  }
  return { kind: 'ok' }
}
