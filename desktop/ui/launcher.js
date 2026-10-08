/* Bundled launch screen only. The HTTP console has no native capabilities. */
(async () => {
  const doc = await (await fetch('strings.json')).json()
  // Start-window language from the system language list (work package 11-2): exact tag match,
  // then primary-subtag match, then the packaged default. Settings.ui.locale is not touched here.
  const keys = Object.keys(doc.by)
  const wanted = (navigator.languages || []).map(x => String(x).toLowerCase())
  const locale = keys.find(k => wanted.includes(k.toLowerCase()))
    ?? keys.find(k => wanted.some(w => w.split('-')[0] === k.split('-')[0]))
    ?? (keys.includes(doc.default) ? doc.default : keys[0])
  document.documentElement.lang = locale
  const strings = doc.by[locale]
  const invoke = window.__TAURI__.core.invoke
  const status = document.getElementById('status'), detail = document.getElementById('detail')
  const retry = document.getElementById('retry'), quit = document.getElementById('quit')
  const importButton = document.getElementById('import')
  importButton.textContent = strings.import
  const recovery = document.getElementById('recover')
  recovery.textContent = strings.restore
  async function copy(recover) {
    importButton.disabled = recovery.disabled = true
    try { await invoke('desktop_import', { recover }) }
    catch (e) { detail.textContent = strings[String(e)] || String(e) }
    finally { importButton.disabled = recovery.disabled = false }
  }
  importButton.onclick = () => copy(false)
  recovery.onclick = () => copy(true)
  retry.textContent = strings.retry
  quit.textContent = strings.quit
  retry.onclick = async () => { retry.disabled = true; try { await invoke('desktop_retry') } finally { retry.disabled = false } }
  quit.onclick = () => invoke('desktop_quit')
  async function poll() {
    try {
      const state = await invoke('desktop_status')
      status.textContent = strings[state.phase] || strings.error
      const [key, port] = state.detail.split(':')
      detail.textContent = (/^\d+$/.test(port || '') && ['portInUse', 'listenFailed'].includes(key))
        ? strings[key].replace('{port}', port) : strings[state.detail] || state.detail || ''
      document.getElementById('data').textContent = strings.data + state.dataDir
      retry.hidden = !['error', 'choose'].includes(state.phase)
      retry.textContent = state.phase === 'choose' ? strings.start : strings.retry
      importButton.hidden = state.phase !== 'choose'
      recovery.hidden = state.phase !== 'recover'
    } catch (e) { detail.textContent = String(e) }
    setTimeout(poll, 500)
  }
  poll()
})()
