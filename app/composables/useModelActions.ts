// Calls to the model management API with one busy flag per action and a toast on failure.
import t from '~~/i18n/zh-CN'

type Failure = keyof typeof t.models.toast

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

export function useModelActions() {
  const toast = useToast()
  const busy = useState<Record<string, boolean>>('model-actions-busy', () => ({}))

  async function run<T>(key: string, failure: Failure, request: () => Promise<T>): Promise<T | null> {
    if (busy.value[key]) return null
    busy.value = { ...busy.value, [key]: true }
    try {
      return await request()
    } catch (e) {
      toast.add({ title: t.models.toast[failure], description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
      return null
    } finally {
      const { [key]: _done, ...rest } = busy.value
      busy.value = rest
    }
  }

  const post = (url: string, body: object = {}) => $fetch(url, { method: 'POST', body })
  const path = (id: string, action: string) => `/api/models/${encodeURIComponent(id)}/${action}`

  return {
    busy,
    start: (id: string, profile?: string) => run(`start:${id}`, 'startFailed', () => post(path(id, 'start'), { profile })),
    stop: (id: string) => run(`stop:${id}`, 'stopFailed', () => post(path(id, 'stop'))),
    retry: (id: string, profile?: string) => run(`retry:${id}`, 'retryFailed', () => post(path(id, 'retry'), { profile })),
    setProfile: (id: string, profile: string) => run(`profile:${id}`, 'profileFailed', () => post(path(id, 'profile'), { profile })),
    enable: async (ref: { dirId: string, rel: string }) => {
      const r = await run(`enable:${ref.dirId}/${ref.rel}`, 'enableFailed', () => post('/api/models', ref)) as { model: { name: string } } | null
      if (r) toast.add({ title: fmt(t.models.toast.enabled, { name: r.model.name }), color: 'success', icon: 'i-lucide-check' })
      return r
    },
  }
}
