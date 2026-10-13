// Visual tokens shared by every scene. Scenes must not invent new colors,
// radii, shadows or font stacks; add a token here instead.

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

// Key content stays inside this box. Subtitles live below `contentBottom`.
export const SAFE = {
  left: 100,
  right: 1820,
  top: 90,
  contentBottom: 880,
} as const;

// Product tokens (dark mode) from the real app: app/assets/css/main.css. See UI-REFERENCE.md.
export const COLORS = {
  bg: '#17181b',
  bgGlow: 'rgba(79, 91, 213, 0.10)',
  surface: '#1f2125',
  surfaceRaised: '#26282d',
  surfaceInset: '#1b1c20',
  term: '#1a1b1f',
  border: '#2d3036',
  borderStrong: '#3b3f46',
  text: '#e4e6ea',
  textMuted: '#a0a7b1',
  textFaint: '#878e99',
  // The single accent color (indigo).
  accent: '#4f5bd5',
  accentText: '#bcc1ef', // --lw-accent-ink: accent mixed 62% with white
  accentSoft: 'rgba(79, 91, 213, 0.22)',
  accentLine: 'rgba(79, 91, 213, 0.75)',
  // Data-flow highlight in concept shots: a light tint of the accent, never a second accent.
  flow: '#bcc1ef',
  flowSoft: 'rgba(188, 193, 239, 0.18)',
  // Neutral wiring before llama-web exists.
  wire: '#4a4e57',
  // Pure white for crisp contrast on saturated accent badges/icons.
  white: '#ffffff',
  ok: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171',
} as const;

export const RADIUS = {
  card: 14,
  control: 10,
  pill: 999,
} as const;

export const SHADOW = {
  card: '0 12px 32px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.18)',
  raised: '0 18px 48px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.22)',
  accentGlow: '0 0 0 1px rgba(79, 91, 213, 0.6), 0 0 48px rgba(79, 91, 213, 0.32)',
} as const;

export const FONT = {
  // Geist is bundled in public/fonts (loaded in fonts.ts); CJK falls back to system fonts.
  sans: '"Geist", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif',
  mono: '"Geist Mono", "SF Mono", Menlo, Consolas, "PingFang SC", monospace',
} as const;

// Font sizes in px for a 1920x1080 frame. Nothing smaller than `tiny` on screen.
export const TYPE = {
  hero: 96,
  subtitle: 46,
  subtitleEn: 24,
  title: 30,
  body: 24,
  small: 20,
  mono: 18,
  tiny: 16,
} as const;

// Spring presets (Remotion `spring` config). Prefer these over ad-hoc configs.
export const SPRING = {
  // Cards and badges appearing: a small overshoot.
  pop: {damping: 14, stiffness: 170, mass: 0.9},
  // Moves and layout changes: crisp, almost no overshoot.
  snappy: {damping: 24, stiffness: 200, mass: 0.9},
  // Fades and slow drifts: no overshoot.
  smooth: {damping: 200, stiffness: 100, mass: 1},
} as const;

export type SpringPreset = keyof typeof SPRING;
