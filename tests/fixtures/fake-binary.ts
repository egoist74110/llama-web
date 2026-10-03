// Minimal executable headers (no code): enough for the platform / architecture check by content.
export function pe(machine: number): Buffer {
  const b = Buffer.alloc(0x100)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.writeUInt32LE(0x00004550, 0x80)
  b.writeUInt16LE(machine, 0x84)
  return b
}
export const peX64 = () => pe(0x8664)
export const peArm64 = () => pe(0xaa64)

export function machoThin(cpu: number): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(cpu, 4)
  return b
}
export const machoArm64 = () => machoThin(0x0100000c)
export const machoX64 = () => machoThin(0x01000007)

export function machoUniversal(cpus: number[]): Buffer {
  const b = Buffer.alloc(8 + cpus.length * 20 + 16)
  b.writeUInt32BE(0xcafebabe, 0)
  b.writeUInt32BE(cpus.length, 4)
  cpus.forEach((c, i) => b.writeUInt32BE(c, 8 + i * 20))
  return b
}

export function elf(machine: number): Buffer {
  const b = Buffer.alloc(64)
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0)
  b.writeUInt16LE(machine, 0x12)
  return b
}
