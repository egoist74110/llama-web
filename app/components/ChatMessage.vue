<script setup lang="ts">
// One message bubble. Model text goes through renderMarkdown, which escapes everything first.
import t from '~~/i18n/zh-CN'
import { renderMarkdown, type ChatMessage } from '~/utils/chat'

const props = defineProps<{ message: ChatMessage, streaming?: boolean, canRegenerate?: boolean }>()
defineEmits<{ regenerate: [] }>()
const M = t.chat.message

const html = computed(() => renderMarkdown(props.message.content))
const thinkingHtml = computed(() => renderMarkdown(props.message.reasoning))
const speed = computed(() => {
  const s = props.message.stats
  if (!s || s.perSec === null) return ''
  return fmt(M.speed, { tokens: s.tokens ?? '–', speed: s.perSec.toFixed(1) })
})
</script>

<template>
  <div class="flex flex-col gap-1.5" :class="message.role === 'user' ? 'items-end' : 'items-start'">
    <span class="text-xs text-dimmed">{{ message.role === 'user' ? M.you : M.assistant }}</span>

    <div v-if="message.role === 'user'" class="flex max-w-[85%] flex-col gap-2 rounded-xl bg-[var(--lw-accent)] px-3.5 py-2.5 text-white">
      <div v-if="message.images.length" class="flex flex-wrap gap-2">
        <img v-for="(u, i) in message.images" :key="i" :src="u" :alt="M.image" class="max-h-40 max-w-full rounded-lg">
      </div>
      <p v-if="message.content" class="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
        {{ message.content }}
      </p>
    </div>

    <div v-else class="flex w-full max-w-[92%] flex-col gap-2">
      <details v-if="message.reasoning" class="lw-think rounded-lg border border-default bg-[var(--lw-sunken)] px-3 py-2 text-[13px] text-muted">
        <summary class="cursor-pointer select-none text-xs">
          {{ streaming && !message.content ? M.thinkingLive : M.thinking }}
        </summary>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="lw-md mt-2" v-html="thinkingHtml" />
      </details>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="message.content" class="lw-md text-sm" v-html="html" />
      <p v-else-if="streaming && !message.reasoning" class="m-0 text-sm text-dimmed">
        …
      </p>
      <p v-if="message.error" class="m-0 text-[13px] text-[var(--lw-err)]" role="alert">
        {{ message.error }}
      </p>
      <div class="flex items-center gap-3 text-xs text-dimmed">
        <span v-if="speed" class="lw-num font-mono">{{ speed }}</span>
        <UButton v-if="canRegenerate && !streaming" size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" @click="$emit('regenerate')">
          {{ M.regenerate }}
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lw-md :deep(p), .lw-md :deep(ul), .lw-md :deep(ol), .lw-md :deep(blockquote), .lw-md :deep(pre) { margin: 0 0 0.6em; }
.lw-md :deep(:last-child) { margin-bottom: 0; }
.lw-md :deep(h3), .lw-md :deep(h4), .lw-md :deep(h5), .lw-md :deep(h6) { margin: 0.8em 0 0.4em; font-weight: 600; }
.lw-md :deep(ul), .lw-md :deep(ol) { padding-left: 1.4em; }
.lw-md :deep(blockquote) { padding-left: 0.8em; border-left: 3px solid var(--lw-border); color: var(--lw-muted); }
.lw-md :deep(code) { padding: 1px 5px; border-radius: 5px; background: var(--lw-sunken); font-family: var(--font-mono); font-size: 0.9em; }
.lw-md :deep(pre) { padding: 10px 12px; border-radius: 10px; background: var(--lw-term); overflow-x: auto; }
.lw-md :deep(pre code) { padding: 0; background: none; }
.lw-md { overflow-wrap: anywhere; }
</style>
