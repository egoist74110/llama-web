// Generation speed of the last ~40 seconds per instance, sampled once a second from the
// live metrics (useLive) for the overview curve. No extra requests; the layout starts it so
// the curve already has history when the overview page is opened.
import { instanceKey, pushTrend } from '~/utils/overview'

const trend = shallowRef<Map<string, number[]>>(new Map())
let timer: ReturnType<typeof setInterval> | undefined

function sample() {
  const { state, metrics } = useLive()
  const active = metrics.value?.speed.active ?? []
  const live = (state.value?.models ?? []).flatMap(m => m.instances
    .filter(i => i.state === 'ready' || i.state === 'draining')
    .map((i) => {
      const gen = active.find(a => a.modelId === m.id && a.profile === i.profile && a.phase === 'generating')
      return { key: instanceKey(m.id, i.profile), value: gen?.tokensPerSec ?? 0 }
    }))
  trend.value = pushTrend(trend.value, live)
}

export function useSpeedTrend() {
  return {
    trend,
    start() {
      if (import.meta.server || timer) return
      timer = setInterval(sample, 1000)
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
  }
}
