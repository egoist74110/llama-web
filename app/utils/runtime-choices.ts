// Pure helpers for the llama.cpp version and device choices (settings page, edit drawer).
// Wording comes from i18n; nothing here knows about components.
import t from '../../i18n/zh-CN'
import type { DevicesView } from '../../server/core/devices'
import type { RuntimeRow } from '../../server/core/runtime-manager'
import { fmt, formatMiB } from '../composables/useFormat'
import { withEmptyOption, type SelectItemDef } from './select-empty'

/** Name of a build type; empty on a Mac (decision 38: no acceleration wording there). */
export function accelLabel(accel: string, isMac: boolean): string {
  if (isMac) return ''
  return (t.llamacpp.manage.channels as Record<string, string>)[accel] ?? ''
}

/** `b11146`, or the name of a hand-added build (with its number when the name does not already say it). */
export function runtimeBaseName(r: Pick<RuntimeRow, 'kind' | 'label' | 'tag'>): string {
  return r.kind === 'custom' ? `${r.label}${r.tag && !r.label.includes(r.tag) ? ` (${r.tag})` : ''}` : r.tag
}

/** `b11146 · NVIDIA（CUDA）版`, or the name of a hand-added build. */
export function runtimeRowLabel(r: Pick<RuntimeRow, 'kind' | 'label' | 'tag' | 'accel'>, isMac: boolean): string {
  const accel = accelLabel(r.accel, isMac)
  const name = runtimeBaseName(r)
  return accel ? `${name} · ${accel}` : name
}

/**
 * Select items for a build choice: "follow the upper layer" first, then every build of this host.
 * A stored reference that is not in the list stays selectable and is marked as missing.
 */
export function runtimeItems(rows: readonly RuntimeRow[], current: string, isMac: boolean, inheritLabel: string = t.models.edit.rd.inherit): SelectItemDef[] {
  const items = rows.map(r => ({ label: runtimeRowLabel(r, isMac), value: r.ref }))
  if (current && !items.some(i => i.value === current)) {
    items.push({ label: fmt(t.models.edit.rd.runtimeMissing, { value: current }), value: current })
  }
  return withEmptyOption(inheritLabel, items)
}

/** Label of a device row: `CUDA0 · RTX 5090 · 32.0 GiB，空闲 30.0 GiB`. */
export function gpuLabel(g: DevicesView['gpus'][number]): string {
  const rd = t.models.edit.rd
  const vars = { id: g.id, name: g.name, memory: formatMiB(g.totalMiB), free: g.freeMiB === null ? '' : formatMiB(g.freeMiB) }
  return fmt(g.freeMiB === null ? rd.deviceGpu : rd.deviceGpuFree, vars)
}

/**
 * Select items for a device choice: follow, automatic, each GPU (with its memory), CPU. `view` is null
 * while the list is loading or failed; a stored device that is not in the list stays selectable.
 */
export function deviceItems(view: DevicesView | null, current: string, inheritLabel: string = t.models.edit.rd.inherit): SelectItemDef[] {
  const rd = t.models.edit.rd
  const items: SelectItemDef[] = [
    { label: rd.deviceAuto, value: 'auto' },
    ...(view?.gpus ?? []).map(g => ({ label: gpuLabel(g), value: g.id })),
    { label: rd.deviceCpu, value: 'cpu' },
  ]
  if (current && !items.some(i => i.value === current)) {
    items.push({ label: fmt(rd.deviceMissing, { value: current }), value: current })
  }
  return withEmptyOption(inheritLabel, items)
}

/** The text a preview shows for the device a launch uses (`auto`, `cpu` or an id). */
export function deviceUsedText(device: string): string {
  const rd = t.models.edit.rd
  return fmt(rd.deviceUsed, { device: device === 'auto' ? rd.deviceUsedAuto : device === 'cpu' ? rd.deviceUsedCpu : device })
}

/** Group the rows of a build list by channel, in the order the host has them (official channels first, hand-added after each). */
export function groupByChannel(rows: readonly RuntimeRow[], channels: readonly string[]): Array<{ accel: string, rows: RuntimeRow[] }> {
  return channels.map(accel => ({ accel, rows: rows.filter(r => r.accel === accel) }))
}
