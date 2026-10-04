import { describe, expect, test } from 'bun:test'
import t from '../../i18n/zh-CN'
import { modelStartNoticeView } from '../../app/utils/model-start-notice'

describe('launch failure recovery', () => {
  const notice = (kind: string, isMac = false) => modelStartNoticeView({ modelId: 'model/one', name: 'Model One', kind }, isMac)
  test('no runtime explicitly explains installation and links to the download card', () => {
    const v = notice('no-runtime')
    expect(v.reason).toBe(t.models.startFailure.noRuntime)
    expect(v.advice).toContain('尚未下载或安装')
    expect(v.recovery).toEqual({ label: t.models.startFailure.download, to: '/settings#s-llama' })
  })
  test('known failures lead to the setting that can resolve them', () => {
    for (const kind of ['dll-missing', 'spawn-failed', 'unsupported-arch']) expect(notice(kind).recovery.to).toBe('/settings#s-llama')
    for (const kind of ['timeout', 'no-port', 'port-in-use']) expect(notice(kind).recovery.to).toBe('/settings#s-server')
    for (const kind of ['file-missing', 'bad-model']) expect(notice(kind).recovery.to).toBe('/settings#s-dirs')
    for (const kind of ['oom', 'device-missing', 'bad-args', 'unknown-arg', 'mmproj-mismatch', 'split-mode-failed', 'split-mode-unsupported', 'profile-missing']) {
      expect(notice(kind).recovery).toEqual({ label: t.models.startFailure.edit, to: null })
    }
  })
  test('unknown failures lead to filtered logs, with a usable event-log fallback', () => {
    expect(notice('unknown').recovery.to).toBe('/logs?model=model%2Fone')
    expect(modelStartNoticeView({ name: '', kind: 'unknown' }, false).recovery.to).toBe('/logs?tab=events')
  })
  test('configuration and registry errors explain an actionable next step', () => {
    expect(notice('model-missing').recovery.to).toBe('/models')
    for (const kind of ['no-port', 'model-missing', 'profile-missing', 'register-failed', 'aborted']) {
      expect(notice(kind).advice).not.toBe(t.failure.advice.unknown)
    }
  })
  test('Mac memory, crash and missing-runtime reasons retain platform wording', () => {
    for (const kind of ['oom', 'crashed', 'no-runtime']) {
      const v = notice(kind, true)
      expect(`${v.reason} ${v.advice}`).not.toMatch(/GPU|显存|CUDA|Metal|[A-Z]:\\/)
    }
  })
})
