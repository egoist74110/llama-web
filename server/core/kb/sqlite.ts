// Tiny common face of `bun:sqlite` (the built server and tests run on Bun) and `node:sqlite` (`nuxt dev` runs on Node).
// Self-contained on purpose (no imports): the specifiers are not literals, so neither the bundler nor the type checker
// tries to resolve a module that only exists on one runtime.

export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number, lastInsertRowid: number }
  all<T = any>(...params: SqlValue[]): T[]
  get<T = any>(...params: SqlValue[]): T | undefined
}

export interface SqlDatabase {
  readonly engine: 'bun:sqlite' | 'node:sqlite'
  exec(sql: string): void
  /** Cached per SQL text. */
  prepare(sql: string): SqlStatement
  /** BEGIN IMMEDIATE ... COMMIT; a throw rolls back. A nested call joins the outer transaction. */
  transaction<T>(fn: () => T): T
  close(): void
}

const BUN = 'bun:sqlite'
const NODE = 'node:sqlite'

/** Open (creating when missing) a database file in WAL mode. */
export async function openDatabase(file: string): Promise<SqlDatabase> {
  const isBun = !!(process.versions as Record<string, string | undefined>).bun
  const specifier = isBun ? BUN : NODE
  const mod: any = await import(/* @vite-ignore */ specifier)
  const raw: any = isBun ? new mod.Database(file, { create: true }) : new mod.DatabaseSync(file)
  const cache = new Map<string, SqlStatement>()
  const rawStatements: any[] = []
  let depth = 0
  const db: SqlDatabase = {
    engine: isBun ? BUN : NODE,
    exec: (sql) => { raw.exec(sql) },
    prepare(sql) {
      let st = cache.get(sql)
      if (!st) {
        const s = raw.prepare(sql)
        rawStatements.push(s)
        st = {
          run: (...p) => {
            const r = s.run(...p)
            return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
          },
          all: (...p) => s.all(...p),
          get: (...p) => s.get(...p) ?? undefined,
        }
        cache.set(sql, st)
      }
      return st
    },
    transaction(fn) {
      if (depth > 0) return fn()
      raw.exec('BEGIN IMMEDIATE')
      depth++
      try {
        const r = fn()
        raw.exec('COMMIT')
        return r
      } catch (e) {
        try { raw.exec('ROLLBACK') } catch { /* the connection is already unusable */ }
        throw e
      } finally {
        depth--
      }
    },
    close() {
      cache.clear()
      // bun:sqlite keeps the file open (and locked on Windows) until every prepared statement is finalized.
      for (const s of rawStatements.splice(0)) {
        try { s.finalize?.() } catch { /* already finalized */ }
      }
      raw.close()
    },
  }
  try {
    raw.exec('PRAGMA journal_mode = WAL')
    raw.exec('PRAGMA synchronous = NORMAL')
    raw.exec('PRAGMA busy_timeout = 5000')
  } catch (e) {
    raw.close()
    throw e
  }
  return db
}
