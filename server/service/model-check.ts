// Glue of the save-time check (decisions 43, 44): builds the launch preview of a (possibly unsaved) profile, reads the
// files and the machine, and hands everything to the pure `checkLaunch`. Used by POST /api/models/:id/check and by the
// profile save. Nothing here writes configuration.
import type { ModelConfig } from '../core/config'
import { t } from '../core/i18n'
import { previewLaunch, requestedRuntime, type LaunchPreview } from '../core/launch'
import { checkLaunch, type CheckIssue, type ModelCheck } from '../core/model-check'
import { fileBytes, loadModelFacts } from '../core/model-facts'
import { ProfileError, sanitizeForm } from '../core/models-admin'
import { readGpuChoice } from '../core/gpu-group'
import { mtpExtraArgs } from '../core/mtp'
import { resolveFileRef } from '../core/scanner'
import type { DraftInput, ModelFacts } from '../core/memory-estimate'
import { getContext } from './context'
import { requireProfile } from './models-api'

const refOrNull = (v: unknown, fallback: ModelConfig['file'] | null) => {
  if (v === undefined) return fallback
  if (v === null) return null
  const r = v as { dirId?: unknown, rel?: unknown }
  if (typeof r.dirId !== 'string' || typeof r.rel !== 'string') throw createError({ statusCode: 400, message: t.models.errors.badRequest })
  return { dirId: r.dirId, rel: r.rel }
}

export interface PreviewBody { profile?: unknown, form?: unknown, files?: Record<string, unknown> }

/** Command preview of a profile with the values on screen (`form` / `files`) laid over the saved ones. */
export async function buildPreview(model: ModelConfig, body: PreviewBody | undefined, profile: string): Promise<{ preview: LaunchPreview, shown: ModelConfig }> {
  const saved = model.profiles[profile]!
  const ctx = getContext()
  // Values on screen win; the saved profile fills in what the form does not carry (its device choice is five fields, see gpu-group.ts).
  const form = body?.form === undefined ? undefined : sanitizeForm(body.form)
  const runtime = form?.runtime === undefined ? saved.runtime ?? null : form.runtime
  const gpu = form?.gpu ?? readGpuChoice(saved)
  const files = body?.files ?? {}
  const shown: ModelConfig = {
    ...model,
    file: refOrNull(files.file, model.file)!,
    mmproj: refOrNull(files.mmproj, model.mmproj),
    draft: refOrNull(files.draft, model.draft),
  }
  if (form?.mtp) shown.draft = form.mtp.enabled && form.mtp.mode === 'file' ? form.mtp.draft : null
  const preview = previewLaunch({
    dataDir: ctx.dataDir, settings: ctx.getSettings(), model: shown, host: ctx.runner.host, target: ctx.runtimeTarget, runtimeEnv: ctx.runtimes.env(),
    form: { overrides: form?.overrides ?? saved.overrides, extraArgs: form?.mtp ? mtpExtraArgs(form.extraArgs, form.mtp) : form?.extraArgs ?? saved.extraArgs, chatTemplate: form ? form.chatTemplate : saved.chatTemplate ?? null, runtime, ...gpu },
    deviceInfo: (await ctx.getDeviceInfo(requestedRuntime(shown, runtime))) ?? undefined,
    comboRecord: key => ctx.splitStats.get(key),
  })
  return { preview, shown }
}

/** Check one profile (saved, or as it is on screen when `body.form` / `body.files` carry values). */
export async function checkProfile(model: ModelConfig, profile: string, body?: PreviewBody, opts: { fresh?: boolean } = {}): Promise<ModelCheck & { online: boolean }> {
  const ctx = getContext()
  const { preview, shown } = await buildPreview(model, body, profile)
  const settings = ctx.getSettings()
  const abs = (ref: ModelConfig['file'] | null) => (ref ? resolveFileRef(settings.modelDirs, ref) : null)

  const facts = async (path: string | null): Promise<ModelFacts | null> => {
    if (!path) return null
    try { return await loadModelFacts(path) } catch { return null }
  }
  const main = await facts(abs(shown.file))
  const mm = abs(shown.mmproj)
  const dr = abs(shown.draft)
  const drFacts = await facts(dr)
  const probe = await ctx.getMemoryProbe(preview.runtime.ref, { refresh: opts.fresh === true })
  const draft: DraftInput | null = drFacts ? { facts: drFacts, params: undefined } : null
  const check = checkLaunch({
    args: preview.args, device: preview.device, requestedGpuLayers: preview.requestedGpuLayers, warnings: preview.warnings,
    os: ctx.platform.os, cpuBuild: preview.runtime.accel === 'cpu',
    model: main, mmprojBytes: mm ? await fileBytes(mm) : 0, hasMmproj: !!shown.mmproj, draft,
    list: probe.list, fallbackGpus: probe.fallbackGpus, system: probe.system, missing: preview.missing,
  })
  return { ...check, online: ctx.ops.upProfiles(model.id).length > 0 }
}

/** Chinese text of one issue. */
export function issueText(i: CheckIssue): string {
  const texts = t.models.check.issues as Record<string, string>
  return (texts[i.code] ?? i.code).replace(/\{(\w+)\}/g, (m, k: string) => (i.detail && k in i.detail ? String(i.detail[k]) : m))
}

/**
 * The save refuses a profile that cannot start (only `error` issues, see model-check.ts); a failing check itself never
 * blocks a save. Returns the check for the response.
 */
export async function checkBeforeSave(model: ModelConfig, name: string, body: { form?: unknown }): Promise<(ModelCheck & { online: boolean }) | null> {
  let check: ModelCheck & { online: boolean }
  try {
    check = await checkProfile(model, requireProfile(model, name), { form: body.form })
  } catch (e) {
    console.error('[llama-web] save check failed:', (e as Error)?.message ?? e)
    return null
  }
  const errors = check.issues.filter(i => i.severity === 'error')
  if (errors.length) throw new ProfileError('check-failed', 'check-failed', errors.map(issueText).join(' '))
  return check
}
