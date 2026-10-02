import { importData } from '../../desktop/import-data'
importData(process.argv[2]!, process.argv[3]!, (phase, name) => {
  if (phase === 'publish' && name === 'settings.json') {
    console.log('checkpoint')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
})
