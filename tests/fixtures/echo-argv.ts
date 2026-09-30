// Fixture: prints argv (excluding runtime and script) as JSON.
console.log(JSON.stringify(process.argv.slice(2)))
