// Interface flags for this host, from the live snapshot (see utils/platform-ui.ts).
export function usePlatformUi() {
  const { state } = useLive()
  return computed(() => platformUi(state.value?.platform?.os))
}
