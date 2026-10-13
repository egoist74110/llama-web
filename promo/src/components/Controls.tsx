import React from 'react';
import {COLORS, FONT, RADIUS, TYPE} from '../theme';

// Small UI primitives for the mock app screens. Keep mock UI built from these so it looks
// like one product.

export const Pill: React.FC<{
  tone?: 'neutral' | 'accent' | 'ok' | 'danger' | 'flow';
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({tone = 'neutral', children, style}) => {
  const tones = {
    neutral: {bg: 'rgba(255,255,255,0.06)', fg: COLORS.textMuted, bd: COLORS.border},
    accent: {bg: COLORS.accentSoft, fg: COLORS.accentText, bd: COLORS.accentLine},
    ok: {bg: 'rgba(92, 207, 154, 0.12)', fg: COLORS.ok, bd: 'rgba(92, 207, 154, 0.35)'},
    danger: {bg: 'rgba(224, 101, 111, 0.12)', fg: COLORS.danger, bd: 'rgba(224, 101, 111, 0.40)'},
    flow: {bg: COLORS.flowSoft, fg: COLORS.flow, bd: 'rgba(98, 214, 232, 0.40)'},
  }[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        borderRadius: RADIUS.pill,
        background: tones.bg,
        color: tones.fg,
        border: `1px solid ${tones.bd}`,
        fontSize: TYPE.tiny,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
};

// Primary (accent filled) or secondary button. `pressed` 0..1 shrinks it for a click.
export const Button: React.FC<{
  label: string;
  primary?: boolean;
  pressed?: number;
  style?: React.CSSProperties;
}> = ({label, primary = true, pressed = 0, style}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 44,
      padding: '0 22px',
      borderRadius: RADIUS.control,
      background: primary ? COLORS.accent : 'rgba(255,255,255,0.06)',
      border: primary ? 'none' : `1px solid ${COLORS.borderStrong}`,
      color: primary ? '#fff' : COLORS.text,
      fontSize: TYPE.small,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      transform: `scale(${1 - 0.06 * pressed})`,
      filter: `brightness(${1 - 0.12 * pressed})`,
      ...style,
    }}
  >
    {label}
  </div>
);

export const StatusDot: React.FC<{tone?: 'ok' | 'idle' | 'accent' | 'danger'; size?: number; glow?: number}> = ({
  tone = 'ok',
  size = 10,
  glow = 0,
}) => {
  const color = {ok: COLORS.ok, idle: COLORS.textFaint, accent: COLORS.accent, danger: COLORS.danger}[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: RADIUS.pill,
        background: color,
        boxShadow: glow > 0 ? `0 0 ${10 * glow}px ${color}` : 'none',
        flexShrink: 0,
      }}
    />
  );
};

// Label + read-only input box (for forms in the mock UI). Put a <Typewriter> in `children`.
export const Field: React.FC<{
  label: string;
  width: number;
  focused?: boolean;
  mono?: boolean;
  children?: React.ReactNode;
}> = ({label, width, focused = false, mono = true, children}) => (
  <div style={{display: 'flex', flexDirection: 'column', gap: 8, width}}>
    <div style={{fontSize: TYPE.tiny, color: COLORS.textMuted, fontWeight: 600}}>{label}</div>
    <div
      style={{
        height: 48,
        boxSizing: 'border-box',
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        borderRadius: RADIUS.control,
        background: COLORS.surfaceInset,
        border: `1px solid ${focused ? COLORS.accentLine : COLORS.border}`,
        boxShadow: focused ? `0 0 0 3px ${COLORS.accentSoft}` : 'none',
        fontFamily: mono ? FONT.mono : FONT.sans,
        fontSize: TYPE.mono,
        color: COLORS.text,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  </div>
);

export const ProgressBar: React.FC<{value: number; width: number; height?: number}> = ({
  value,
  width,
  height = 8,
}) => (
  <div
    style={{
      width,
      height,
      borderRadius: RADIUS.pill,
      background: 'rgba(255,255,255,0.07)',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        width: `${Math.max(0, Math.min(1, value)) * 100}%`,
        height: '100%',
        borderRadius: RADIUS.pill,
        background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.accentText})`,
        boxShadow: `0 0 12px ${COLORS.accentSoft}`,
      }}
    />
  </div>
);

// Mouse pointer for simulated clicks. `press` 0..1 shows a click ripple.
export const Cursor: React.FC<{x: number; y: number; press?: number; opacity?: number}> = ({
  x,
  y,
  press = 0,
  opacity = 1,
}) => (
  <div style={{position: 'absolute', left: x, top: y, opacity, pointerEvents: 'none'}}>
    <div
      style={{
        position: 'absolute',
        left: -22,
        top: -22,
        width: 44,
        height: 44,
        borderRadius: RADIUS.pill,
        border: `2px solid ${COLORS.accentText}`,
        opacity: press > 0 && press < 1 ? 1 - press : 0,
        transform: `scale(${0.4 + press * 0.9})`,
      }}
    />
    <svg width={28} height={34} viewBox="0 0 28 34" style={{position: 'absolute', left: -3, top: -2}}>
      <path
        d="M3 2 L3 27 L9.5 21 L14 31 L18.5 29 L14 19.5 L23 19.5 Z"
        fill="#ffffff"
        stroke="#14151a"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

// Mock application window: title bar with three dots, then content.
export const AppWindow: React.FC<{
  cx: number;
  cy: number;
  w: number;
  h: number;
  title: string;
  scale?: number;
  opacity?: number;
  children?: React.ReactNode;
}> = ({cx, cy, w, h, title, scale = 1, opacity = 1, children}) => (
  <div
    style={{
      position: 'absolute',
      left: cx - w / 2,
      top: cy - h / 2,
      width: w,
      height: h,
      borderRadius: RADIUS.card,
      background: COLORS.surface,
      border: `1px solid ${COLORS.borderStrong}`,
      boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
      transform: `scale(${scale})`,
      opacity,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    <div
      style={{
        height: 48,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 18px',
        borderBottom: `1px solid ${COLORS.border}`,
        background: COLORS.surfaceInset,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{width: 12, height: 12, borderRadius: RADIUS.pill, background: 'rgba(255,255,255,0.12)'}}
        />
      ))}
      <span style={{marginLeft: 14, fontSize: TYPE.tiny, color: COLORS.textMuted, fontWeight: 600}}>{title}</span>
    </div>
    <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>{children}</div>
  </div>
);
