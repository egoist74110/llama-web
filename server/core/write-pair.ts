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
