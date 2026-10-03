// Form state of one device choice (single device or GPU group, decision 45) and its conversion to / from the
// five stored fields. Pure helpers; the wording is in i18n and the component is DeviceChoice.vue.
import type { DevicesView } from '../../server/core/devices'
import type { GpuChoice } from '../../server/core/gpu-group'

export interface GpuForm {
  /** Single choice: '' = inherit (automatic at the root), `auto`, `cpu` or one id. */
  device: string
  /** The "use several GPUs" switch; on = `devices` is the choice. */
  multi: boolean
  devices: string[]
  splitMode: string
  tensorSplit: string
  mainGpu: string
}

export const emptyGpuForm = (): GpuForm => ({ device: '', multi: false, devices: [], splitMode: '', tensorSplit: '', mainGpu: '' })

/** The form for stored fields: the switch is on when a group (two or more devices) is stored. */
export function gpuFormFrom(o: GpuChoice | null | undefined): GpuForm {
  const devices = Array.isArray(o?.devices) ? [...o.devices] : []
  const multi = devices.length >= 2
  return {
    device: multi ? '' : o?.device ?? '', multi, devices: multi ? devices : [],
    splitMode: multi ? o?.splitMode ?? '' : '', tensorSplit: multi ? o?.tensorSplit ?? '' : '', mainGpu: multi ? o?.mainGpu ?? '' : '',
  }
}

/** The five fields to send (all of them, so a switch back to a single device clears the group). */
export function gpuBody(f: GpuForm): { device: string, devices: string[], splitMode: string, tensorSplit: string, mainGpu: string } {
  if (!f.multi) return { device: f.device, devices: [], splitMode: '', tensorSplit: '', mainGpu: '' }
  return { device: '', devices: [...f.devices], splitMode: f.splitMode, tensorSplit: f.tensorSplit.trim(), mainGpu: f.mainGpu }
}

/** Id of the GPU with the most memory (the one `auto` takes with several GPUs), or null. */
export const largestGpuId = (view: DevicesView | null): string | null =>
  view?.gpus.length ? view.gpus.reduce((b, g) => (g.totalMiB > b.totalMiB ? g : b)).id : null

/** Turn the switch on (start from the single device or the largest GPU) or off (back to one device, never to nothing). */
export function toggleMulti(f: GpuForm, on: boolean, view: DevicesView | null): GpuForm {
  if (on === f.multi) return f
  const ids = new Set((view?.gpus ?? []).map(g => g.id))
  if (on) {
    const start = ids.has(f.device) ? f.device : largestGpuId(view)
    return { ...f, multi: true, device: '', devices: start ? [start] : [], splitMode: '', tensorSplit: '', mainGpu: '' }
  }
  return { ...emptyGpuForm(), device: f.devices[0] ?? '' }
}

/** Check / uncheck one GPU. Keeps the order of the device list and never leaves the group empty. */
export function toggleDevice(f: GpuForm, id: string, on: boolean, view: DevicesView | null): GpuForm {
  const order = (view?.gpus ?? []).map(g => g.id)
  const next = on ? [...new Set([...f.devices, id])] : f.devices.filter(d => d !== id)
  if (!next.length) return f
  // Ids the list does not know (a card that is gone) stay at the end.
  const rank = (x: string) => (order.indexOf(x) < 0 ? 1e6 : order.indexOf(x))
  next.sort((a, b) => rank(a) - rank(b))
  // The ratio and the main GPU belong to the old order: they are cleared when the group changes.
  return { ...f, devices: next, tensorSplit: '', mainGpu: '' }
}

/** Memory shares of the chosen GPUs for the ratio hint: placeholder like `32,24`, shares like `CUDA0 57%，CUDA1 43%`. */
export function ratioHint(f: GpuForm, view: DevicesView | null): { placeholder: string, shares: string } {
  const gpus = f.devices.map(id => view?.gpus.find(g => g.id === id)).filter((g): g is DevicesView['gpus'][number] => !!g && g.totalMiB > 0)
  if (gpus.length !== f.devices.length || !gpus.length) return { placeholder: '', shares: '' }
  const total = gpus.reduce((s, g) => s + g.totalMiB, 0)
  return {
    placeholder: gpus.map(g => Math.max(1, Math.round(g.totalMiB / 1024))).join(','),
    shares: gpus.map(g => `${g.id} ${Math.round((g.totalMiB / total) * 100)}%`).join('，'),
  }
}

/** The ratio is empty or numbers separated by commas, one per chosen GPU. */
export function ratioValid(f: GpuForm): boolean {
  const v = f.tensorSplit.trim()
  if (!f.multi || v === '') return true
  return /^\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*$/.test(v) && v.split(',').length === f.devices.length && v.split(',').some(p => Number(p) > 0)
}

/** True when the experimental split modes (row / tensor) are chosen for a real group. */
export const experimentalChosen = (f: GpuForm): boolean => f.multi && f.devices.length >= 2 && (f.splitMode === 'row' || f.splitMode === 'tensor')
