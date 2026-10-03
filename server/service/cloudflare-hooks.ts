// How the one-click tunnel setup touches the config files: the port guard and the final save.
// Kept out of context.ts so a test runs exactly this wiring against real stores.
import type { SetupHooks } from '../core/cloudflare'
import type { Settings } from '../core/config'
import type { SecretsDoc } from '../core/keys'
import { type Hold, writePair } from '../core/write-pair'

/** What openStore returns (cached value, re-read from disk, save). */
export interface StoreRef<T> {
  get(): T
  refresh(): T
  update(fn: (draft: T) => T | void): T
}

export function cloudflareHooks(o: {
  settingsRef: StoreRef<Settings>
  secretsRef: StoreRef<SecretsDoc>
  /** Mutes the reactions of both stores while the pair of writes is in flight. */
  hold: Hold
  /** Bring the public listener and the tunnel in line with the files (once, after the writes). */
  applyPublic: () => void
  onChange?: SetupHooks['onChange']
}): SetupHooks {
  const { settingsRef, secretsRef, hold } = o
  return {
    // On success: save the tunnel token, then switch the public entry and hosting (own tunnel, not
    // the quick one) on and show the hostname as the client address. Both files or neither: the
    // hosted tunnel is only switched after both writes went through; one reconciliation afterwards,
    // whether they did or not (see Hold).
    // The token itself is never logged.
    onSaved: ({ tunnelToken, hostname }) => {
      const previous = secretsRef.get().tunnelToken
      hold.run(() => writePair(
        () => secretsRef.update((draft) => { draft.tunnelToken = tunnelToken }),
        () => settingsRef.update((draft) => { draft.public = { ...draft.public, enabled: true, tunnelEnabled: true, tunnelMode: 'token', domain: hostname } }),
        () => secretsRef.update((draft) => { draft.tunnelToken = previous }),
      ), o.applyPublic)
    },
    // Read fresh: a hand edit the file watcher has not delivered yet counts too (and is then applied like any other).
    localPort: () => {
      try { settingsRef.refresh() } catch { /* unreadable file: the cached settings are all there is */ }
      return settingsRef.get().public.port
    },
    onChange: o.onChange,
  }
}
