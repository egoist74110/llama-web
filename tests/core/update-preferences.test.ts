import { expect, test } from 'bun:test'
import { defaultModels, defaultSettings, normalizeSettings, SETTINGS_MIGRATIONS } from '../../server/core/config'
import { applySettingsPatch } from '../../server/core/settings-admin'

test('runtime settings migration disables automatic installation while preserving selected versions and launch parameters', () => {
  const old = defaultSettings()
  old.version = 6
  old.llamacpp.autoUpdate = true
  old.llamacpp.current = 'b200'
  old.llamacpp.currentCpu = 'b100'
  const next = SETTINGS_MIGRATIONS[6]!(structuredClone(old))
  expect(next).toEqual({ ...old, llamacpp: { ...old.llamacpp, autoUpdate: false } })
  expect(defaultSettings().llamacpp.autoUpdate).toBe(false)
})

test('settings API accepts only a boolean auto-update preference, keeping all other runtime settings', () => {
  const cfg = defaultSettings()
  const before = structuredClone(cfg.llamacpp)
  applySettingsPatch(cfg, { llamacpp: { autoUpdate: true } }, defaultModels())
  expect(cfg.llamacpp).toEqual({ ...before, autoUpdate: true })
  for (const patch of [{ autoUpdate: 'false' }, { autoUpdate: true, current: 'b999' }, null]) {
    expect(() => applySettingsPatch(cfg, { llamacpp: patch }, defaultModels())).toThrow()
  }
  const bad = defaultSettings()
  bad.llamacpp.autoUpdate = 'false' as never
  expect(() => normalizeSettings(bad)).toThrow()
})
