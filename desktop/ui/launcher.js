/* Bundled launch screen only. The HTTP console has no native capabilities. */
(async () => {
  const strings = await (await fetch('strings.json')).json()
  const invoke = window.__TAURI__.core.invoke
  const status = document.getElementById('status'), detail = document.getElementById('detail')
  const retry = document.getElementById('retry'), quit = document.getElementById('quit')
  const importButton = document.getElementById('import')
  importButton.textContent = strings.import
  importButton.onclick = async () => { importButton.disabled = true; try { await invoke('desktop_import') } finally { importButton.disabled = false } }
  retry.textContent = strings.retry
  quit.textContent = strings.quit
  retry.onclick = async () => { retry.disabled = true; try { await invoke('desktop_retry') } finally { retry.disabled = false } }
  quit.onclick = () => invoke('desktop_quit')
  async function poll() {
    try {
      const state = await invoke('desktop_status')
      status.textContent = strings[state.phase] || strings.error
      detail.textContent = state.detail || ''
      document.getElementById('data').textContent = strings.data + state.dataDir
      retry.hidden = !['error', 'choose'].includes(state.phase)
      retry.textContent = state.phase === 'choose' ? strings.start : strings.retry
      importButton.hidden = state.phase !== 'choose'
    } catch (e) { detail.textContent = String(e) }
    setTimeout(poll, 500)
  }
  poll()
})()
