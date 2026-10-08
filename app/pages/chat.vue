<script setup lang="ts">
// Chat page (decision 55): talks to the local /v1/chat/completions of a model that is already
// running. It never starts a model; conversations live only in this browser.
import { t } from '../composables/useLocale'
import { sessionImageBytes } from '~/utils/chat'

const c = useChat()
const T = t.chat

const box = ref<HTMLElement | null>(null)
let stick = true
const onScroll = () => {
  const el = box.value
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function toBottom(force = false) {
  nextTick(() => {
    const el = box.value
    if (el && (stick || force)) el.scrollTop = el.scrollHeight
  })
}
const last = computed(() => c.current.value?.messages.at(-1))
watch(() => [last.value?.content, last.value?.reasoning, c.current.value?.messages.length], () => toBottom())
watch(() => c.currentId.value, () => { stick = true; toBottom(true) })

const onSend = (text: string, images: string[]) => { stick = true; void c.send(text, images) }
const used = computed(() => (c.current.value ? sessionImageBytes(c.current.value) : 0))
const messages = computed(() => c.current.value?.messages ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="T.title" :subtitle="T.subtitle">
      <template v-if="c.options.value.length" #actions>
        <USelect v-model="c.selected.value" :items="c.options.value" class="w-60" :disabled="c.busy.value" :aria-label="T.model" />
      </template>
    </PageHeader>

    <p v-if="!c.persistent.value" class="m-0 text-xs text-[var(--lw-warn)]" role="status">
      {{ T.sessions.unsaved }}
    </p>

    <section v-if="c.loaded.value && !c.options.value.length" class="lw-card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <UIcon name="i-lucide-message-square-off" class="size-8 text-dimmed" />
      <h2 class="m-0 text-[15px] font-semibold">
        {{ T.noModel.title }}
      </h2>
      <p class="m-0 max-w-md text-[13px] text-muted">
        {{ T.noModel.body }}
      </p>
      <UButton to="/models" color="primary" icon="i-lucide-box">
        {{ T.noModel.go }}
      </UButton>
    </section>

    <div v-else class="grid gap-4 min-[900px]:grid-cols-[230px_minmax(0,1fr)]">
      <ChatSessions
        :sessions="c.sessions.value"
        :current-id="c.currentId.value"
        :busy="c.busy.value"
        class="max-h-48 min-[900px]:h-[calc(100dvh-210px)] min-[900px]:max-h-none"
        @new="c.startNew"
        @select="c.select"
        @rename="c.rename"
        @remove="c.remove"
      />
      <section class="lw-card flex h-[calc(100dvh-240px)] min-h-[420px] min-w-0 flex-col overflow-hidden min-[900px]:h-[calc(100dvh-210px)]">
        <div ref="box" class="flex flex-1 flex-col gap-5 overflow-auto p-5" @scroll="onScroll">
          <p v-if="!messages.length" class="m-auto text-sm text-dimmed">
            {{ T.composer.placeholder }}
          </p>
          <ChatMessage
            v-for="(m, i) in messages"
            :key="m.id"
            :message="m"
            :streaming="c.busy.value && i === messages.length - 1"
            :can-regenerate="i === messages.length - 1 && m.role === 'assistant'"
            @regenerate="c.regenerate"
          />
        </div>
        <ChatComposer
          :busy="c.busy.value"
          :can-send="!!c.option.value"
          :vision="!!c.option.value?.hasMmproj"
          :used-bytes="used"
          @send="onSend"
          @stop="c.stop"
        />
      </section>
    </div>
  </div>
</template>
