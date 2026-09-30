import { fileURLToPath } from 'node:url'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  typescript: { strict: true },
  nitro: { preset: 'bun' },
  $production: {
    // Custom Bun entry (plan 关键决定 25), build only: `nuxt dev` must keep Nitro's dev
    // worker entry (it runs on Node). Must be an absolute path; `~~` is not resolved here.
    nitro: { entry: fileURLToPath(new URL('./server/entry.ts', import.meta.url)) },
  },
})
