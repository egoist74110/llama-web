import { fileURLToPath } from 'node:url'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/ui'],
  // Geist / Geist Mono ship with the app (decision 30): no font is fetched from the network,
  // neither at build time (@nuxt/fonts is off) nor at run time (the desktop app may be offline).
  css: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', '~/assets/css/main.css'],
  ui: { fonts: false },
  // Local console: a pure SPA. Live data comes from /api/stream, so SSR would add nothing.
  ssr: false,
  icon: { clientBundle: { scan: true } },
  devtools: { enabled: false },
  // Match the main production entry: local clients may connect from other LAN devices.
  devServer: { host: '0.0.0.0' },
  typescript: { strict: true },
  nitro: { preset: 'bun' },
  $production: {
    // Custom Bun entry (plan 关键决定 25), build only: `nuxt dev` must keep Nitro's dev
    // worker entry (it runs on Node). Must be an absolute path; `~~` is not resolved here.
    nitro: { entry: fileURLToPath(new URL('./server/entry.ts', import.meta.url)) },
  },
})
