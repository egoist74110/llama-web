// The application's own version and update source, taken from package.json at build time
// (the desktop package version is the same file: tauri.conf.json points at it).
import pkg from '../../package.json'

export const APP_VERSION: string = pkg.version

/** `owner/name` of the GitHub repository whose Releases carry application updates. */
export const APP_REPO: string = (() => {
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(pkg.repository.url)
  if (!m) throw new Error('package.json repository must be a GitHub URL')
  return m[1]!
})()
