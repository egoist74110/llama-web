// Startup: kill llama-server processes left over from a previous run (see core/residue.ts).
import { runStartupCleanup } from '../core/residue'
import { resolveDataDir } from '../core/store'

export default defineNitroPlugin(() => {
  runStartupCleanup(resolveDataDir()).then((r) => {
    if (r.killed.length || r.skipped.length) {
      console.info(`[llama-web] residue cleanup: killed ${r.killed.length}, skipped ${r.skipped.length}`)
    }
  }, (e) => {
    console.error('[llama-web] residue cleanup failed', e)
  })
})
