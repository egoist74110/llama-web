// Knowledge base errors (decision 65). The code is the key under `t.kb.errors`; `detail` is free text for logs and for
// the `{detail}` placeholder of a message.
export type KbErrorCode =
  | 'bad-body' | 'bad-name' | 'name-taken' | 'bad-description' | 'bad-chunk-size' | 'bad-overlap'
  | 'not-found' | 'doc-not-found'
  | 'unsupported-type' | 'too-large' | 'empty-file' | 'not-text' | 'decode-failed' | 'duplicate' | 'no-text'
  | 'empty-query' | 'bad-tags' | 'bad-similarity' | 'engine-off' | 'embed-failed' | 'busy'
  // entries, trash, guide (decision 69)
  | 'bad-title' | 'bad-entry-body' | 'bad-base-version' | 'bad-doc-name' | 'bad-guide'
  | 'entry-not-found' | 'version-not-found' | 'version-conflict' | 'not-in-trash' | 'no-raw'
  // stored on a document that could not be (fully) indexed
  | 'interrupted' | 'no-engine' | 'model-mismatch' | 'dims-mismatch'

export class KbError extends Error {
  /** `data` is an optional payload for the API body (the current entry of a `version-conflict`). */
  constructor(public code: KbErrorCode, public detail: string = '', public data?: unknown) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'KbError'
  }
}
