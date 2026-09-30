// Shared plain types for the Nitro-independent core modules.

/** A model file reference: model directory id + path relative to it (forward slashes). */
export interface FileRef {
  dirId: string
  rel: string
}

export interface ModelDir {
  id: string
  path: string
  enabled: boolean
  /** Number of sub-directory levels below the root that are scanned (0 = root only). */
  maxDepth: number
}
