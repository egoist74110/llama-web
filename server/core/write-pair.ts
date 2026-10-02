// Two writes that belong together (secrets.json + settings.json after the one-click tunnel setup).
// Each file is written atomically, but the pair is not: when the second write fails the first is
// undone, so nothing half-applied is left behind. Reactions to the new values (restarting the
// tunnel, ...) are for the caller to run after both writes went through.
export function writePair(first: () => void, second: () => void, undoFirst: () => void): void {
  first()
  try {
    second()
  } catch (e) {
    try {
      undoFirst()
    } catch (undoError) {
      // Both failed: report the original failure, keep the undo failure visible.
      throw new AggregateError([e, undoError], `${(e as Error)?.message ?? e} (and the undo failed: ${(undoError as Error)?.message ?? undoError})`)
    }
    throw e
  }
}

/**
 * Mutes the reactions to config changes while a group of writes is in flight and runs one
 * reconciliation afterwards, on success and on failure alike: changes that arrived meanwhile (a
 * hand edit read by the writes' own refresh) are never lost, and a failed group leaves the running
 * state matching whatever the files finally say.
 */
export class Hold {
  private depth = 0

  get held(): boolean {
    return this.depth > 0
  }

  run<T>(fn: () => T, reconcile: () => void): T {
    this.depth++
    try {
      return fn()
    } finally {
      this.depth--
      if (this.depth === 0) reconcile()
    }
  }
}
