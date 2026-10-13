import React from 'react';
import {COLORS} from '../theme';

export type GlyphName =
  | 'chat'
  | 'agent'
  | 'code'
  | 'chip'
  | 'cloud'
  | 'server'
  | 'key'
  | 'image'
  | 'check'
  | 'cube'
  | 'globe';

// Line icons drawn in a 24x24 box. Stroke only, inherits the given color.
const PATHS: Record<GlyphName, React.ReactNode> = {
  chat: (
    <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z" />
  ),
  agent: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12.5v1M15 12.5v1M2 12v3M22 12v3" />
    </>
  ),
  code: <path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15" />,
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
    </>
  ),
  cloud: <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.5 9.6 4.5 4.5 0 0 0 7 18.5z" />,
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="7" rx="2" />
      <rect x="3.5" y="13" width="17" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12 20 3M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m3.5 18 5.5-5.5 4 4 2.5-2.5 5 4.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cube: (
    <>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
};

export const Glyph: React.FC<{name: GlyphName; size?: number; color?: string; strokeWidth?: number}> = ({
  name,
  size = 24,
  color = COLORS.textMuted,
  strokeWidth = 1.8,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{flexShrink: 0, display: 'block'}}
  >
    {PATHS[name]}
  </svg>
);

// Glyph inside a rounded tile, used as the leading icon on cards.
export const GlyphTile: React.FC<{name: GlyphName; size?: number; accent?: boolean}> = ({
  name,
  size = 48,
  accent = false,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: 12,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: accent ? COLORS.accentSoft : 'rgba(255,255,255,0.05)',
      border: `1px solid ${accent ? COLORS.accentLine : COLORS.border}`,
    }}
  >
    <Glyph name={name} size={size * 0.55} color={accent ? COLORS.accentText : COLORS.textMuted} />
  </div>
);
