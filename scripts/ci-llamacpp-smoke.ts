// CI smoke test for the real llama.cpp release of this host (run by .github/workflows/ci.yml on macOS):
// resolve the newest official build, download and install it into a temporary data directory with the
// same code the app uses, then run `llama-server --version`. It loads no model.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLatest, installedDir, serverExeName } from '../server/core/llamacpp'
import { detectPlatform, runtimeTarget } from '../server/core/platform'
import { defaultRunVersion, parseVersionOutput } from '../server/core/runtime-add'

const info = detectPlatform()
const target = runtimeTarget(info, 'auto')
const dataDir = mkdtempSync(join(tmpdir(), 'lw-ci-'))
try {
  console.log(`host: ${info.os}/${info.arch}, runtime: ${target.acceleration}`)
  const tag = await installLatest({ dataDir, cudaRuntime: '', target, onStep: (step, detail) => console.log(`${step} ${detail}`.trim()) })
  const dir = installedDir(dataDir, tag, target)
  const out = await defaultRunVersion(join(dir, serverExeName()), dir, 60_000)
  const parsed = parseVersionOutput(out)
  console.log(parsed.line)
  if (parsed.tag !== tag) throw new Error(`--version reports "${parsed.tag}", expected ${tag}`)
  console.log(`ok: ${tag} runs on ${info.os}/${info.arch}`)
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
