// Recovery destinations for diagnosed launch failures. Never start, download or change settings here.
import t from '../../i18n/zh-CN'
import { failureAdvice, loadErrorText } from './platform-text'
import type { ModelStartNotice } from '../composables/useModelStartFeedback'

export function modelStartNoticeView(notice: ModelStartNotice, isMac: boolean) {
  const s = t.models.startFailure
  const kind = notice.kind
  const runtime = ['no-runtime', 'dll-missing', 'spawn-failed', 'unsupported-arch'].includes(kind)
  const server = ['timeout', 'no-port', 'port-in-use'].includes(kind)
  const dirs = ['file-missing', 'bad-model'].includes(kind)
  const edit = ['oom', 'bad-args', 'unknown-arg', 'device-missing', 'mmproj-mismatch', 'split-mode-unsupported', 'split-mode-failed', 'profile-missing'].includes(kind)
  const logTo = notice.modelId ? `/logs?model=${encodeURIComponent(notice.modelId)}` : '/logs?tab=events'
  const recovery = runtime ? { label: kind === 'no-runtime' ? s.download : s.runtime, to: '/settings#s-llama' }
    : server ? { label: s.server, to: '/settings#s-server' }
      : dirs ? { label: s.dirs, to: '/settings#s-dirs' }
        : edit && notice.modelId ? { label: s.edit, to: null }
          : kind === 'model-missing' ? { label: s.models, to: '/models' }
          : { label: s.logs, to: logTo }
  return {
    reason: kind === 'no-runtime' ? s.noRuntime : loadErrorText(kind, isMac),
    advice: (s.advice as Record<string, string>)[kind] ?? failureAdvice(kind, isMac),
    recovery,
    logTo,
  }
}
