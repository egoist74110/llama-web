// Persistent automatic-check throttle. Attempts count even when offline or interrupted.
import { JsonStore } from './store'

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
interface CheckRecord { at: number, result: unknown }
interface CheckDoc { version: number, checks: Record<string, CheckRecord> }

export class UpdateCheckStore {
  private readonly store: JsonStore<CheckDoc>
  private value: CheckDoc

  constructor(dataDir: string) {
    this.store = new JsonStore<CheckDoc>({
      dataDir, name: 'update-checks.json', version: 1, keepBackups: 3,
      defaults: () => ({ version: 1, checks: {} }),
      validate: d => {
        if (!d.checks || typeof d.checks !== 'object' || Array.isArray(d.checks)) throw new Error('Invalid update checks')
        const checks: Record<string, CheckRecord> = {}
        for (const [key, record] of Object.entries(d.checks)) {
          if (record && Number.isFinite(record.at) && record.at >= 0) checks[key] = { at: record.at, result: record.result ?? null }
        }
        return { version: 1, checks }
      },
    })
    try { this.value = this.store.load() }
    catch { this.value = { version: 1, checks: {} } }
  }

  get(key: string): CheckRecord | undefined {
    return this.value.checks[key]
  }

  remaining(key: string, now: number, interval = UPDATE_CHECK_INTERVAL_MS): number {
    const at = this.get(key)?.at
    // A future timestamp after a clock correction must not suppress checks indefinitely.
    return at === undefined || now < at ? 0 : Math.max(0, interval - (now - at))
  }

  save(key: string, at: number, result: unknown = null): void {
    // Refresh before updating: CPU, GPU and application checks share this file.
    this.value = this.store.update(d => { d.checks[key] = { at, result } })
  }
}
