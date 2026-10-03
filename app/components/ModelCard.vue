<script setup lang="ts">
// One enabled model: state, start / stop / retry, profile dropdown, missing-file warning.
import t from '~~/i18n/zh-CN'
import type { StateDoc } from '~~/server/core/live'
import { quantFromFile } from '~/utils/overview'

const props = defineProps<{ model: StateDoc['models'][number] }>()
const { busy, start, stop, retry, setProfile } = useModelActions()
const { state: live } = useLive()
const ui = usePlatformUi()

// Shown state: the current profile's instance, else whatever profile is up.
const shown = computed(() => props.model.instances.find(i => i.profile === props.model.activeProfile) ?? props.model.instances[0] ?? null)
const state = computed(() => shown.value?.state ?? 'stopped')
// Waiting for another model to unload first: no instance yet, but a load is queued.
const queued = computed(() => state.value === 'stopped' && !!live.value?.queue.some(q => q.modelId === props.model.id))
const otherProfile = computed(() => (shown.value && shown.value.profile !== props.model.activeProfile ? shown.value.profile : null))
const missing = computed(() => props.model.missing)
const failed = computed(() => state.value === 'failed' || state.value === 'crashed')
const winding = computed(() => state.value === 'draining' || state.value === 'unloading')
const editing = ref(false)
const firstStart = ref(false)
const quant = computed(() => quantFromFile(props.model.files.model))
const progress = computed(() => shown.value?.progress ?? null)
// A model enabled from a scan asks its first-start questions before the first load.
const onStart = () => (props.model.needsSetup ? (firstStart.value = true) : start(props.model.id))
const working = computed(() => !!(busy.value[`start:${props.model.id}`] || busy.value[`stop:${props.model.id}`] || busy.value[`retry:${props.model.id}`]))
</script>

<template>
  <div class="lw-row flex flex-col gap-3 px-5 py-4">
    <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
      <div class="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <span class="text-[15px] font-semibold">{{ model.name }}</span>
          <span v-if="queued" class="lw-st lw-st-loading">{{ t.models.card.queued }}</span>
          <StatusPill v-else :state="state" />
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span v-if="quant" class="lw-chip font-mono">{{ quant }}</span>
          <span v-if="model.hasMmproj" class="lw-chip lw-chip-accent">
            <UIcon name="i-lucide-image" class="size-3" />{{ t.models.card.mmproj }}
          </span>
          <span v-else class="lw-chip">{{ t.models.card.mmprojNone }}</span>
          <span v-if="model.files.draft" class="lw-chip">{{ t.models.card.draft }}</span>
        </div>
        <p class="m-0 break-all font-mono text-xs text-dimmed" :title="model.files.model">
          {{ model.files.model }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2" :title="t.models.card.profileHint">
          <span class="text-xs text-dimmed">{{ t.models.card.profile }}</span>
          <USelect
            :model-value="model.activeProfile"
            :items="model.profiles"
            size="sm"
            class="w-32"
            :disabled="!!busy[`profile:${model.id}`]"
            :aria-label="t.models.card.profile"
            @update:model-value="(p: string) => setProfile(model.id, p)"
          />
        </div>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-pencil" :aria-label="t.models.edit.open" :title="t.models.edit.open" @click="editing = true" />
        <UButton
          v-if="state === 'stopped' && !queued"
          size="sm"
          icon="i-lucide-play"
          class="min-w-[76px] justify-center"
          :disabled="missing.length > 0"
          :loading="working"
          @click="onStart"
        >
          {{ t.models.card.start }}
        </UButton>
        <UButton
          v-if="failed"
          size="sm"
          icon="i-lucide-rotate-cw"
          class="min-w-[76px] justify-center"
          :disabled="missing.length > 0"
          :loading="working"
          @click="retry(model.id, shown?.profile)"
        >
          {{ t.models.card.retry }}
        </UButton>
        <UButton
          v-if="state !== 'stopped' || queued"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-square"
          class="min-w-[76px] justify-center"
          :disabled="winding"
          :loading="working || winding"
          @click="stop(model.id)"
        >
          {{ winding ? t.models.card.stopping : t.models.card.stop }}
        </UButton>
      </div>
    </div>

    <div v-if="state === 'loading'" class="flex items-center gap-3">
      <div class="lw-bar warn flex-1"><span :style="{ width: `${progress ?? 0}%` }" /></div>
      <span v-if="progress !== null" class="lw-num w-10 text-right font-mono text-xs text-muted">{{ progress }}%</span>
    </div>
    <p v-if="otherProfile" class="m-0 text-xs text-muted">
      {{ fmt(t.models.card.runningProfile, { profile: otherProfile }) }}
    </p>
    <FailureCard
      v-if="shown?.failure && failed"
      :model-id="model.id"
      :profile="shown.profile"
      :state="shown.state"
      :failure="shown.failure"
    />
    <p v-else-if="shown?.error" class="m-0 text-sm text-error">
      {{ loadErrorText(shown.error, ui.isMac) }}
    </p>
    <div v-if="missing.length" class="rounded-[10px] bg-error/10 px-3.5 py-2.5 text-sm text-error">
      <p class="m-0 font-medium">
        {{ t.models.card.missingTitle }}
      </p>
      <ul class="m-0 mt-0.5 list-disc pl-5">
        <li v-for="m in missing" :key="m">
          {{ t.models.card.missing[m] }}
        </li>
      </ul>
      <p class="m-0 mt-1 text-xs opacity-80">
        {{ t.models.card.missingHint }}
      </p>
    </div>
    <ModelEditor v-model:open="editing" :model-id="model.id" />
    <FirstStartDialog v-if="model.needsSetup" v-model:open="firstStart" :model-id="model.id" :name="model.name" />
  </div>
</template>
