// Calls to the model API; explicit starts also follow their background outcome through SSE.
import t from '~~/i18n/zh-CN'

type Failure = keyof typeof t.models.toast

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

export function useModelActions() {
  const toast = useToast()
  const feedback = useModelStartFeedback()
  const busy = useState<Record<string, boolean>>('model-actions-busy', () => ({}))

  async function run<T>(key: string, failure: Failure, request: () => Promise<T>, onError?: (e: unknown) => void): Promise<T | null> {
    if (busy.value[key]) return null
    busy.value = { ...busy.value, [key]: true }
    try {
      return await request()
    } catch (e) {
      if (onError) onError(e)
      else toast.add({ title: t.models.toast[failure], description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
      return null
    } finally {
      const { [key]: _done, ...rest } = busy.value
      busy.value = rest
    }
  }

  const post = (url: string, body: object = {}) => $fetch(url, { method: 'POST', body })
  const path = (id: string, action: string) => `/api/models/${encodeURIComponent(id)}/${action}`

  const launch = (action: 'start' | 'retry', id: string, profile?: string) => run(`${action}:${id}`, action === 'start' ? 'startFailed' : 'retryFailed', async () => {
    const attempt = feedback.begin(id, profile)
    try {
      const result = await post(path(id, action), { profile })
      feedback.accepted(attempt)
      return result
    } catch (e) {
      feedback.httpFailure(e, attempt)
      return null
    }
  })

  return {
    busy,
    start: (id: string, profile?: string) => launch('start', id, profile),
    stop: (id: string) => run(`stop:${id}`, 'stopFailed', () => { feedback.cancel(id); return post(path(id, 'stop')) }),
    retry: (id: string, profile?: string) => launch('retry', id, profile),
    setProfile: (id: string, profile: string) => run(`profile:${id}`, 'profileFailed', () => post(path(id, 'profile'), { profile })),
    saveFiles: (id: string, body: object) => run(`files:${id}`, 'editFailed', () => post(path(id, 'files'), body)) as Promise<{ restarted: boolean } | null>,
    profileOp: (id: string, body: object) => run(`profiles:${id}`, 'profileOpFailed', () => post(path(id, 'profiles'), body)) as Promise<{ name?: string, restarted?: boolean } | null>,
    enable: async (ref: { dirId: string, rel: string }) => {
      const r = await run(`enable:${ref.dirId}/${ref.rel}`, 'enableFailed', () => post('/api/models', ref), e => feedback.httpFailure(e, undefined, ref.rel)) as { model: { name: string } } | null
      if (r) toast.add({ title: fmt(t.models.toast.enabled, { name: r.model.name }), color: 'success', icon: 'i-lucide-check' })
      return r
    },
  }
}
