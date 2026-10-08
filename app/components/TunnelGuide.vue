<script setup lang="ts">
// Step-by-step guide for creating the tunnel in the Cloudflare dashboard. The pictures are
// schematic SVGs (labels use the dashboard's own English wording); nothing here is account data.
import { t } from '../composables/useLocale'

// `open`: start expanded; `bare`: no separator above (inside the public access guide).
const props = defineProps<{ ingress: string, open?: boolean, bare?: boolean }>()
const g = t.tunnel.guide
const m = g.mock
const steps = computed(() => g.steps.map(x => ({ title: x.title, body: fmt(x.body, { url: props.ingress }) })))
</script>

<template>
  <details :open="props.open" :class="props.bare ? '' : 'mt-4 border-t border-default pt-4'">
    <summary class="cursor-pointer text-sm font-medium text-highlighted">
      {{ g.title }}
    </summary>
    <p class="mt-2 text-xs text-muted">
      {{ g.intro }}
    </p>
    <ol class="mt-3 space-y-5">
      <li v-for="(step, i) in steps" :key="i" class="flex gap-3">
        <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{{ i + 1 }}</span>
        <div class="min-w-0 flex-1 space-y-2">
          <p class="text-sm font-medium text-default">
            {{ step.title }}
          </p>
          <p class="text-xs leading-relaxed text-muted">
            {{ step.body }}
          </p>

          <!-- 1: menu -->
          <svg v-if="i === 0" class="w-full max-w-sm" viewBox="0 0 360 150" role="img" :aria-label="step.title" font-size="11" font-family="inherit">
            <rect x="1" y="1" width="358" height="148" rx="8" fill="var(--ui-bg)" stroke="var(--ui-border)" />
            <rect x="1" y="1" width="110" height="148" rx="8" fill="var(--ui-bg-muted)" stroke="var(--ui-border)" />
            <text x="14" y="30" fill="var(--ui-text-highlighted)" font-weight="600">{{ m.zeroTrust }}</text>
            <text x="26" y="56" fill="var(--ui-text-muted)">{{ m.networks }}</text>
            <rect x="22" y="68" width="82" height="24" rx="5" fill="var(--ui-primary)" opacity="0.15" />
            <text x="34" y="84" fill="var(--ui-primary)" font-weight="600">{{ m.tunnels }}</text>
            <rect x="132" y="22" width="150" height="14" rx="4" fill="var(--ui-border)" />
            <rect x="132" y="48" width="210" height="10" rx="4" fill="var(--ui-border)" opacity="0.6" />
            <rect x="132" y="68" width="190" height="10" rx="4" fill="var(--ui-border)" opacity="0.6" />
            <path d="M108 76 l8 4 l-8 4" fill="none" stroke="var(--ui-primary)" stroke-width="2" />
          </svg>

          <!-- 2: create -->
          <svg v-else-if="i === 1" class="w-full max-w-sm" viewBox="0 0 360 150" role="img" :aria-label="step.title" font-size="11" font-family="inherit">
            <rect x="1" y="1" width="358" height="148" rx="8" fill="var(--ui-bg)" stroke="var(--ui-border)" />
            <rect x="16" y="14" width="112" height="26" rx="5" fill="var(--ui-primary)" />
            <text x="28" y="31" fill="var(--ui-bg)" font-weight="600">{{ m.create }}</text>
            <rect x="16" y="54" width="150" height="40" rx="6" fill="var(--ui-bg-muted)" stroke="var(--ui-primary)" stroke-width="2" />
            <text x="28" y="78" fill="var(--ui-text-highlighted)" font-weight="600">{{ m.cloudflared }}</text>
            <text x="16" y="116" fill="var(--ui-text-muted)">{{ m.tunnelName }}</text>
            <rect x="16" y="122" width="200" height="20" rx="4" fill="var(--ui-bg-muted)" stroke="var(--ui-border)" />
            <text x="24" y="136" fill="var(--ui-text)">{{ m.tunnelNameValue }}</text>
          </svg>

          <!-- 3: token command -->
          <svg v-else-if="i === 2" class="w-full max-w-sm" viewBox="0 0 360 150" role="img" :aria-label="step.title" font-size="11" font-family="inherit">
            <rect x="1" y="1" width="358" height="148" rx="8" fill="var(--ui-bg)" stroke="var(--ui-border)" />
            <rect x="16" y="16" width="70" height="24" rx="5" fill="var(--ui-primary)" opacity="0.15" stroke="var(--ui-primary)" />
            <text x="28" y="32" fill="var(--ui-primary)" font-weight="600">{{ m.windows }}</text>
            <rect x="16" y="56" width="328" height="34" rx="6" fill="var(--ui-bg-muted)" stroke="var(--ui-border)" />
            <text x="26" y="77" fill="var(--ui-text)" font-family="monospace" font-size="10">{{ m.command }}</text>
            <rect x="300" y="62" width="38" height="22" rx="4" fill="var(--ui-primary)" opacity="0.15" stroke="var(--ui-primary)" stroke-width="2" />
            <rect x="313" y="68" width="10" height="10" rx="2" fill="none" stroke="var(--ui-primary)" stroke-width="1.5" />
            <rect x="16" y="108" width="80" height="24" rx="5" fill="var(--ui-primary)" />
            <text x="40" y="124" fill="var(--ui-bg)" font-weight="600">{{ m.next }}</text>
          </svg>

          <!-- 4: public hostname -->
          <svg v-else-if="i === 3" class="w-full max-w-sm" viewBox="0 0 360 170" role="img" :aria-label="step.title" font-size="11" font-family="inherit">
            <rect x="1" y="1" width="358" height="168" rx="8" fill="var(--ui-bg)" stroke="var(--ui-border)" />
            <text x="16" y="26" fill="var(--ui-text-highlighted)" font-weight="600">{{ m.hostname }}</text>
            <text x="16" y="48" fill="var(--ui-text-muted)">{{ m.subdomain }}</text>
            <text x="150" y="48" fill="var(--ui-text-muted)">{{ m.domain }}</text>
            <rect x="16" y="54" width="120" height="20" rx="4" fill="var(--ui-bg-muted)" stroke="var(--ui-border)" />
            <rect x="150" y="54" width="190" height="20" rx="4" fill="var(--ui-bg-muted)" stroke="var(--ui-border)" />
            <text x="16" y="98" fill="var(--ui-text-muted)">{{ m.service }}</text>
            <text x="16" y="116" fill="var(--ui-text-muted)">{{ m.type }}</text>
            <rect x="60" y="104" width="80" height="20" rx="4" fill="var(--ui-bg-muted)" stroke="var(--ui-primary)" stroke-width="2" />
            <text x="72" y="118" fill="var(--ui-text)">{{ m.http }}</text>
            <text x="16" y="146" fill="var(--ui-text-muted)">{{ m.url }}</text>
            <rect x="60" y="132" width="200" height="20" rx="4" fill="var(--ui-bg-muted)" stroke="var(--ui-primary)" stroke-width="2" />
            <text x="70" y="146" fill="var(--ui-text)" font-family="monospace">{{ props.ingress }}</text>
          </svg>

          <!-- 5: healthy -->
          <svg v-else class="w-full max-w-sm" viewBox="0 0 360 70" role="img" :aria-label="step.title" font-size="11" font-family="inherit">
            <rect x="1" y="1" width="358" height="68" rx="8" fill="var(--ui-bg)" stroke="var(--ui-border)" />
            <text x="16" y="28" fill="var(--ui-text-highlighted)" font-weight="600">{{ m.tunnelNameValue }}</text>
            <text x="16" y="52" fill="var(--ui-text-muted)">{{ m.status }}</text>
            <rect x="62" y="40" width="74" height="18" rx="9" fill="var(--ui-success)" opacity="0.18" />
            <circle cx="74" cy="49" r="3.5" fill="var(--ui-success)" />
            <text x="83" y="53" fill="var(--ui-success)" font-weight="600" font-size="10">{{ m.connected }}</text>
          </svg>
        </div>
      </li>
    </ol>
  </details>
</template>
