// English wording (decision 18). This is the skeleton written by work package 11-1: the groups mirror
// i18n/zh-CN.ts and the comments say what each group holds. The translations themselves are the job
// of the later packages of stage 11; a key that is not written here falls back to Chinese through
// i18n/fill.ts, so the interface stays complete while the translation is in progress.
//
// Rules for filling it in, all of them checked by tests/core/i18n-parity.test.ts:
//  - keys and nesting follow i18n/zh-CN.ts; a key that is not in Chinese is dropped and reported;
//  - `{name}` placeholders stay exactly as they are in the Chinese text;
//  - no Chinese / Japanese / Korean characters and no empty strings in what is written here;
//  - an array keeps the Chinese length and order (it is merged entry by index).
import zh from './zh-CN'
import { deepMergeWithFallback } from './fill'
import type { Messages, PartialMessages } from './messages'

/** What has actually been written in English so far: the groups are there, the text is not. */
export const enSkeleton: PartialMessages = {
  // Desktop shell start window: choosing or copying an old data directory, recovery, start / stop / update states.
  desktop: {},

  // `runtimeHint` is shared wording; `mac` replaces the Windows wording on a Mac (decision 38): no GPU, VRAM or drive letters.
  platform: { mac: {} },

  // Window title and subtitle.
  app: {},

  // Left menu entries.
  nav: {},

  // Shell: model and runtime badges, connection state, theme names, the "serving" line.
  layout: { serving: {} },

  // Model state names and the runtime line of the header.
  status: { states: {}, runtime: {} },

  // Overview page: API card, hero card, tiles, online models, recent requests.
  overview: { api: {}, hero: {}, tiles: {}, online: {}, recent: {}, gpu: {} },

  // Event log texts: state changes, drain timeout, no room and its reasons, watchdog, tunnel, runtime fallback.
  events: { noRoom: {}, noRoomReason: {}, watchdog: {}, tunnel: {}, runtimeFallback: {}, runtime: {} },

  // Memory estimate: tiers, hints, the per-part breakdown, notes, per-card chips.
  memory: { noun: {}, tier: {}, tierHint: {}, parts: {}, notes: {}, chip: {} },

  // Duration templates ("{n} 秒" and friends).
  duration: {},

  // Model page: tabs, filter, adding a directory, first-start and discovery questions, errors, start /
  // guard / remove dialogs, the edit drawer (the deepest group of the file), start failures, toasts.
  models: {
    tabs: {}, filter: {}, addDir: {}, enabled: {}, card: {}, firstStart: {}, thinkingLimit: {},
    discover: {}, errors: {}, start: {}, guard: {}, check: {}, remove: {}, edit: {}, startFailure: {}, toast: {},
  },

  // Settings page: directory list, launch defaults, system section, image preprocessing, server settings,
  // save errors. The language control itself is work package 11-2.
  settings: { dirs: {}, defaults: {}, system: {}, image: {}, server: {}, errors: {}, public: {} },

  // Public access guide: steps, port, key, path, Cloudflare token / zone / run, quick tunnel limits, address overview.
  publicAccess: { steps: {}, port: {}, key: {}, path: {}, cfToken: {}, zone: {}, run: {}, guide: {}, quickLimits: {}, paste: {}, connect: {}, overview: {}, check: {} },

  // Tunnel state: token handling, quick tunnel, cloudflared, exit codes, dashboard guide.
  tunnel: { off: {}, preparing: {}, cloudflaredFrom: {}, codes: {}, errors: {}, guide: {} },

  // Cloudflare branch of the guide: token help, zone, tunnel and DNS choice, warnings, confirm, steps, cleanup, errors.
  cloudflare: { howToken: {}, howDomain: {}, permissions: {}, zoneReason: {}, actions: {}, choice: {}, warnings: {}, steps: {}, stepState: {}, cleanupWhat: {}, errors: {} },

  // llama.cpp runtime management: current version, rollback, update state, manual runtime entries.
  llamacpp: { update: {}, errors: {}, manage: {}, runtimes: {} },

  // Machine warnings (driver, CUDA, memory, disk).
  system: { warnings: {} },

  // External upstreams (decision 56): cards, editor, removal, errors, manual launch, connection test.
  upstreams: { page: {}, form: {}, remove: {}, errors: {}, launch: {}, test: {} },

  // API key page: create, show / copy, revoke, errors.
  keys: { errors: {} },

  // First-run wizard: model directory, runtime, enabling a model, first start.
  setup: { dir: {}, runtime: {}, enable: {}, start: {} },

  // Chat page: sessions, messages, composer.
  chat: { noModel: {}, sessions: {}, message: {}, composer: {} },

  // Logs page: tabs, filters, run files, request rows.
  logs: { tabs: {}, filters: {}, view: {}, file: {}, empty: {}, requests: {}, errors: {} },

  // Usage tab: range, cards, chart, group tables, CSV column names.
  usage: { range: {}, cards: {}, chart: {}, groups: {}, columns: {}, names: {}, errors: {} },

  // Import of the old swap-config: preview, run, errors, warnings.
  import: { errors: {}, warnings: {} },

  // Middleware rejections (cross-origin, non-JSON body).
  admin: {},

  // /v1 errors a client sees: model not found, no room, interrupted, unauthorized, internal error.
  api: { noRoom: {} },

  // One line per load-failure reason, keyed exactly like `loadFailureReason()`.
  loadError: {},

  // Load failure panel: advice per error class, exit code, log tail, retry and rollback buttons.
  failure: { advice: {} },

  // GitHub mirror chooser and the own-prefix setting (decision 53).
  mirror: {},

  // llama-web self update: check, notes, skip, download, install, banner, errors.
  appUpdate: { errors: {} },
}

/** Complete dictionary: every key of zh-CN.ts, Chinese wherever the English text is still missing. */
export const en: Messages = deepMergeWithFallback(zh, enSkeleton)

export default en
