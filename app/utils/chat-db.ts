// Browser-side storage of conversations (IndexedDB; localStorage is too small for images).
// Everything is try/catch'd: when the browser refuses storage, the page keeps working from memory.
import type { ChatSession } from './chat'

export interface ChatBackend {
  readonly persistent: boolean
  all: () => Promise<ChatSession[]>
  put: (s: ChatSession) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function memoryBackend(): ChatBackend {
  const map = new Map<string, ChatSession>()
  return {
    persistent: false,
    all: async () => [...map.values()],
    put: async (s) => { map.set(s.id, JSON.parse(JSON.stringify(s))) },
    remove: async (id) => { map.delete(id) },
  }
}

const DB = 'llama-web-chat'
const STORE = 'sessions'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb'))
    req.onblocked = () => reject(new Error('indexeddb blocked'))
  })
}

const wait = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error ?? new Error('indexeddb'))
})

/** IndexedDB backend; rejects when the browser has no usable IndexedDB (private window, blocked site data). */
export async function idbBackend(): Promise<ChatBackend> {
  const db = await open()
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE)
  return {
    persistent: true,
    all: async () => await wait(store('readonly').getAll()) as ChatSession[],
    put: async (s) => { await wait(store('readwrite').put(JSON.parse(JSON.stringify(s)))) },
    remove: async (id) => { await wait(store('readwrite').delete(id)) },
  }
}
