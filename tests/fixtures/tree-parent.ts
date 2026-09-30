// Fixture: spawns a long-lived child, prints its PID, then idles. Used by process-tree tests.
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
console.log(`child=${child.pid}`)
setInterval(() => {}, 1000)
