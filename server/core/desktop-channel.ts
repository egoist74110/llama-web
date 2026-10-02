// Desktop control travels only over inherited pipes, never through HTTP.
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export const DESKTOP_PREFIX = 'LLAMA_WEB_DESKTOP '
export function desktopChannel(options: {
  session: string, input: Readable, output: Writable, pid: number,
  shutdown: (reason: string) => void,
}) {
  const { session, input, output, pid, shutdown } = options
  if (!/^[a-f0-9-]{36}$/.test(session)) throw new Error('Invalid desktop session')
  let closed = false
  let stopping = false
  const stop = (reason: string) => {
    if (closed || stopping) return
    stopping = true
    shutdown(reason)
  }
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (line.length > 1024) return stop('desktop protocol limit')
    try {
      const msg = JSON.parse(line)
      if (msg.version === 1 && msg.session === session && msg.type === 'shutdown') stop('desktop shutdown')
    } catch { /* Unrelated input cannot authorize a command. */ }
  })
  const eof = () => stop('desktop parent disconnected')
  const error = () => stop('desktop pipe failed')
  lines.on('close', eof)
  input.on('error', error)
  output.on('error', error)
  return {
    ready(port: number) {
      if (closed || stopping) return
      output.write(DESKTOP_PREFIX + JSON.stringify({ version: 1, session, pid, type: 'ready', port }) + '\n')
    },
    close() {
      if (closed) return
      closed = true
      lines.off('close', eof)
      input.off('error', error)
      output.off('error', error)
      lines.close()
      input.pause()
    },
  }
}
