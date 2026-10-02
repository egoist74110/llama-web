import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { desktopChannel, DESKTOP_PREFIX } from '../../server/core/desktop-channel'

const session = '12345678-1234-1234-1234-123456789abc'
function fixture() {
  const input = new PassThrough(), output = new PassThrough()
  const reasons: string[] = []
  let text = ''
  output.on('data', chunk => { text += chunk })
  const channel = desktopChannel({ session, input, output, pid: 123, shutdown: reason => reasons.push(reason) })
  return { input, output, reasons, channel, text: () => text }
}
test('desktop ready contains the current private identity and actual port', () => {
  const f = fixture()
  f.channel.ready(5001)
  expect(JSON.parse(f.text().slice(DESKTOP_PREFIX.length))).toEqual({ version: 1, session, pid: 123, type: 'ready', port: 5001 })
  f.channel.close()
  expect(f.reasons).toEqual([])
})
test('only the inherited session can request shutdown; duplicates stop once', () => {
  const f = fixture()
  f.input.write('bad json\n' + JSON.stringify({ version: 1, session: 'wrong', type: 'shutdown' }) + '\n')
  expect(f.reasons).toEqual([])
  const cmd = JSON.stringify({ version: 1, session, type: 'shutdown' }) + '\n'
  f.input.write(cmd + cmd)
  f.input.end()
  expect(f.reasons).toEqual(['desktop shutdown'])
  f.channel.close()
})
test('parent EOF and broken output request cleanup; close detaches listeners', async () => {
  const f = fixture()
  f.input.end()
  await Bun.sleep(0)
  expect(f.reasons).toEqual(['desktop parent disconnected'])
  f.channel.close()
  expect(f.input.listenerCount('error')).toBe(0)
  expect(f.output.listenerCount('error')).toBe(0)
  const g = fixture()
  g.output.emit('error', new Error('pipe'))
  expect(g.reasons).toEqual(['desktop pipe failed'])
  g.channel.close()
})
