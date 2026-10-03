// Which parts of the interface exist on this host (decision 38). The one place that looks at the
// operating system: components ask these flags and never compare `os` themselves.

export interface PlatformUi {
  /** The host is known (the first live snapshot has arrived); until then nothing platform-specific shows. */
  known: boolean
  isMac: boolean
  /** GPU / acceleration type / device / GPU memory: Windows only. Never rendered on a Mac. */
  hasGpu: boolean
  /** The CPU build is a second channel next to CUDA (Windows): two default-parameter sets, a download button. */
  hasCpuChannel: boolean
  /** The server can open a native folder dialog (Windows dialog, macOS osascript). */
  canPickFolder: boolean
}

export function platformUi(os: string | undefined | null): PlatformUi {
  const known = !!os
  const isMac = os === 'darwin'
  return {
    known,
    isMac,
    hasGpu: known && !isMac,
    hasCpuChannel: os === 'win32',
    canPickFolder: os === 'win32' || os === 'darwin',
  }
}
