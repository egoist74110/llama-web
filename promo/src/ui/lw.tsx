import React from 'react';
import type {LucideIcon} from 'lucide-react';
import {COLORS, FONT} from '../theme';

// Replicas of the real app's building blocks (app/assets/css/main.css, Nuxt UI), at the app's
// native CSS pixel sizes. They are rendered inside <AppShell>, which the <Camera> scales up.
// Keep every size here identical to UI-REFERENCE.md; scenes compose these, they do not restyle them.

export const LW = {
  radiusCard: 14,
  radiusControl: 6,
  shadow: '0 1px 2px rgba(0,0,0,.25)',
  base: 14,
} as const;

type Style = React.CSSProperties;

export const Icon: React.FC<{icon: LucideIcon; size?: number; color?: string; style?: Style}> = ({
  icon: I,
  size = 16,
  color = 'currentColor',
  style,
}) => <I size={size} color={color} strokeWidth={2} style={{flexShrink: 0, display: 'block', ...style}} />;

// .lw-card
export const LwCard: React.FC<{style?: Style; highlight?: boolean; children?: React.ReactNode}> = ({
  style,
  highlight,
  children,
}) => (
  <div
    style={{
      background: COLORS.surface,
      border: `1px solid ${highlight ? COLORS.accent : COLORS.border}`,
      borderRadius: LW.radiusCard,
      boxShadow: highlight ? `0 0 0 1px ${COLORS.accent}, ${LW.shadow}` : LW.shadow,
      ...style,
    }}
  >
    {children}
  </div>
);

// AppCard: title 15px semibold + optional 12px hint, actions top-right.
export const AppCard: React.FC<{
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  style?: Style;
  highlight?: boolean;
  children?: React.ReactNode;
}> = ({title, hint, actions, style, highlight, children}) => (
  <LwCard style={style} highlight={highlight}>
    <div style={{display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 20px 6px'}}>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontSize: 15, fontWeight: 600, color: COLORS.text}}>{title}</div>
        {hint ? <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2, lineHeight: 1.5}}>{hint}</div> : null}
      </div>
      {actions}
    </div>
    <div style={{padding: '10px 20px 18px'}}>{children}</div>
  </LwCard>
);

// PageHeader: h1 24px semibold, 13px muted subtitle, actions right.
export const PageHeader: React.FC<{title: string; subtitle?: string; actions?: React.ReactNode}> = ({
  title,
  subtitle,
  actions,
}) => (
  <div style={{display: 'flex', alignItems: 'flex-end', gap: 16}}>
    <div style={{flex: 1, minWidth: 0}}>
      <div style={{fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em', color: COLORS.text}}>{title}</div>
      {subtitle ? <div style={{fontSize: 13, color: COLORS.textMuted, marginTop: 4}}>{subtitle}</div> : null}
    </div>
    {actions}
  </div>
);

export type PillKind = 'ready' | 'loading' | 'failed' | 'stopped';

// .lw-st status pill. `pulse` (0..1) drives the loading dot blink; pass a frame-derived value.
export const StatusPill: React.FC<{kind: PillKind; label: string; pulse?: number; style?: Style}> = ({
  kind,
  label,
  pulse = 1,
  style,
}) => {
  const c = {
    ready: {fg: COLORS.ok, bg: 'rgba(74,222,128,.12)'},
    loading: {fg: COLORS.warn, bg: 'rgba(251,191,36,.13)'},
    failed: {fg: COLORS.danger, bg: 'rgba(248,113,113,.13)'},
    stopped: {fg: COLORS.textFaint, bg: COLORS.surfaceInset},
  }[kind];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: c.fg,
          opacity: kind === 'loading' ? 0.35 + 0.65 * pulse : 1,
        }}
      />
      {label}
    </span>
  );
};

// .lw-chip / .lw-chip-accent
export const Chip: React.FC<{accent?: boolean; mono?: boolean; icon?: LucideIcon; children: React.ReactNode; style?: Style}> = ({
  accent,
  mono,
  icon,
  children,
  style,
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 22,
      padding: '0 8px',
      borderRadius: 6,
      border: `1px solid ${accent ? 'transparent' : COLORS.border}`,
      background: accent ? COLORS.accentSoft : COLORS.surfaceRaised,
      color: accent ? COLORS.accentText : COLORS.textMuted,
      fontSize: 12,
      fontFamily: mono ? FONT.mono : undefined,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {icon ? <Icon icon={icon} size={12} /> : null}
    {children}
  </span>
);

// Tier pill used on model rows / memory estimate: 放得下 / 有风险 / 放不下.
export const TierPill: React.FC<{tier: 'fit' | 'risk' | 'nofit'; label: string}> = ({tier, label}) => (
  <StatusPill kind={tier === 'fit' ? 'ready' : tier === 'risk' ? 'loading' : 'failed'} label={label} />
);

// .lw-seg segmented control. `active` index; `slide` (0..1) can animate between two indices.
export const Seg: React.FC<{options: readonly React.ReactNode[]; active: number; style?: Style; height?: number}> = ({
  options,
  active,
  style,
  height = 30,
}) => (
  <div
    style={{
      display: 'inline-flex',
      gap: 2,
      padding: 3,
      borderRadius: 10,
      background: COLORS.surfaceInset,
      border: `1px solid ${COLORS.border}`,
      ...style,
    }}
  >
    {options.map((o, i) => (
      <div
        key={i}
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 12px',
          borderRadius: 7,
          fontSize: 13,
          fontWeight: i === active ? 500 : 400,
          color: i === active ? COLORS.text : COLORS.textMuted,
          background: i === active ? COLORS.surface : 'transparent',
          boxShadow: i === active ? LW.shadow : 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {o}
      </div>
    ))}
  </div>
);

// .lw-bar progress bar.
export const Bar: React.FC<{value: number; tone?: 'accent' | 'warn' | 'err' | 'dim'; height?: number; style?: Style}> = ({
  value,
  tone = 'accent',
  height = 6,
  style,
}) => (
  <div style={{height, borderRadius: 999, background: COLORS.surfaceInset, overflow: 'hidden', ...style}}>
    <div
      style={{
        width: `${Math.max(0, Math.min(1, value)) * 100}%`,
        height: '100%',
        borderRadius: 999,
        background: {accent: COLORS.accent, warn: COLORS.warn, err: COLORS.danger, dim: COLORS.textFaint}[tone],
      }}
    />
  </div>
);

// Nuxt UI button. `pressed` 0..1 for click feedback; `size` sm (28px) / md (32px) / xs (24px).
export const Btn: React.FC<{
  label?: string;
  icon?: LucideIcon;
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  size?: 'xs' | 'sm' | 'md';
  pressed?: number;
  disabled?: boolean;
  style?: Style;
}> = ({label, icon, variant = 'primary', size = 'sm', pressed = 0, disabled, style}) => {
  const h = {xs: 24, sm: 28, md: 32}[size];
  const fs = size === 'xs' ? 12 : 13;
  const v = {
    primary: {bg: COLORS.accent, fg: '#fff', bd: 'transparent'},
    outline: {bg: 'transparent', fg: COLORS.text, bd: COLORS.borderStrong},
    ghost: {bg: 'transparent', fg: COLORS.textMuted, bd: 'transparent'},
    danger: {bg: 'transparent', fg: COLORS.danger, bd: 'rgba(248,113,113,.45)'},
  }[variant];
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: h,
        padding: label ? `0 ${size === 'xs' ? 8 : 10}px` : 0,
        width: label ? undefined : h,
        borderRadius: 6,
        background: v.bg,
        color: v.fg,
        border: `1px solid ${v.bd}`,
        fontSize: fs,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        transform: `scale(${1 - 0.05 * pressed})`,
        filter: `brightness(${1 + (variant === 'primary' ? -0.15 : 0.25) * pressed})`,
        boxSizing: 'border-box',
        flexShrink: 0,
        ...style,
      }}
    >
      {icon ? <Icon icon={icon} size={size === 'xs' ? 12 : 14} /> : null}
      {label}
    </div>
  );
};

export const Switch: React.FC<{on: boolean; style?: Style}> = ({on, style}) => (
  <div
    style={{
      width: 32,
      height: 18,
      borderRadius: 999,
      background: on ? COLORS.accent : COLORS.borderStrong,
      position: 'relative',
      flexShrink: 0,
      ...style,
    }}
  >
    <div
      style={{
        position: 'absolute',
        top: 2,
        left: on ? 16 : 2,
        width: 14,
        height: 14,
        borderRadius: 999,
        background: '#fff',
      }}
    />
  </div>
);

// .lw-radio
export const Radio: React.FC<{on: boolean}> = ({on}) => (
  <div
    style={{
      width: 16,
      height: 16,
      borderRadius: 999,
      boxSizing: 'border-box',
      border: on ? `5px solid ${COLORS.accent}` : `1.5px solid ${COLORS.borderStrong}`,
      background: on ? '#fff' : 'transparent',
      flexShrink: 0,
    }}
  />
);

// Text input / select box. `children` is the value (e.g. a <Typewriter>); `placeholder` shows when empty.
export const Input: React.FC<{
  children?: React.ReactNode;
  placeholder?: string;
  mono?: boolean;
  focused?: boolean;
  select?: boolean;
  width?: number | string;
  height?: number;
  style?: Style;
}> = ({children, placeholder, mono, focused, select, width = '100%', height = 32, style}) => (
  <div
    style={{
      width,
      height,
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 10px',
      borderRadius: 6,
      background: COLORS.surfaceInset,
      border: `1px solid ${focused ? COLORS.accent : COLORS.borderStrong}`,
      boxShadow: focused ? `0 0 0 2px ${COLORS.accentSoft}` : 'none',
      fontFamily: mono ? FONT.mono : undefined,
      fontSize: 13,
      color: COLORS.text,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      ...style,
    }}
  >
    <div style={{flex: 1, minWidth: 0, overflow: 'hidden'}}>
      {children ?? <span style={{color: COLORS.textFaint}}>{placeholder}</span>}
    </div>
    {select ? (
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={COLORS.textFaint} strokeWidth={2}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    ) : null}
  </div>
);

// Form field: label (13px, 500) + control + hint (12px dim).
export const Field: React.FC<{label: string; hint?: string; children: React.ReactNode; style?: Style}> = ({
  label,
  hint,
  children,
  style,
}) => (
  <div style={{display: 'flex', flexDirection: 'column', gap: 6, ...style}}>
    <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>{label}</div>
    {children}
    {hint ? <div style={{fontSize: 12, color: COLORS.textFaint, lineHeight: 1.5}}>{hint}</div> : null}
  </div>
);

// Small colored status text line (green "在这个目录里找到 4 个模型文件。" etc.).
export const StatusText: React.FC<{tone?: 'ok' | 'warn' | 'err' | 'muted'; children: React.ReactNode; style?: Style}> = ({
  tone = 'ok',
  children,
  style,
}) => (
  <div
    style={{
      fontSize: 13,
      color: {ok: COLORS.ok, warn: COLORS.warn, err: COLORS.danger, muted: COLORS.textMuted}[tone],
      ...style,
    }}
  >
    {children}
  </div>
);

// Nuxt UI toast, bottom-right of the app viewport. `enter` 0..1.
export const Toast: React.FC<{title: string; enter: number; tone?: 'ok' | 'err'; style?: Style}> = ({title, enter, tone = 'ok', style}) => (
  <div
    style={{
      position: 'absolute',
      right: 20,
      bottom: 20,
      width: 340,
      padding: '12px 14px',
      borderRadius: 10,
      background: COLORS.surface,
      border: `1px solid ${COLORS.borderStrong}`,
      boxShadow: '0 12px 30px rgba(0,0,0,.4)',
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      fontSize: 13,
      color: COLORS.text,
      opacity: enter,
      transform: `translateY(${(1 - enter) * 16}px)`,
      ...style,
    }}
  >
    <span style={{color: tone === 'ok' ? COLORS.ok : COLORS.danger, fontSize: 14, lineHeight: '18px'}}>
      {tone === 'ok' ? '✓' : '!'}
    </span>
    <span style={{lineHeight: 1.45}}>{title}</span>
  </div>
);

// Right-side slide-over drawer (USlideover) over a dimmed page. `enter` 0..1.
export const Drawer: React.FC<{
  width: number;
  enter: number;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}> = ({width, enter, title, description, footer, children}) => (
  <>
    <div style={{position: 'absolute', inset: 0, background: `rgba(0,0,0,${0.45 * enter})`}} />
    <div
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width,
        background: COLORS.surface,
        borderLeft: `1px solid ${COLORS.border}`,
        transform: `translateX(${(1 - enter) * (width + 20)}px)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{padding: '18px 22px 14px', borderBottom: `1px solid ${COLORS.border}`}}>
        <div style={{fontSize: 16, fontWeight: 600, color: COLORS.text}}>{title}</div>
        {description ? <div style={{fontSize: 13, color: COLORS.textMuted, marginTop: 4}}>{description}</div> : null}
      </div>
      <div style={{flex: 1, overflow: 'hidden', position: 'relative'}}>{children}</div>
      {footer ? (
        <div
          style={{
            padding: '12px 22px',
            borderTop: `1px solid ${COLORS.border}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  </>
);

// Centered modal (UModal) over a dimmed page. `enter` 0..1.
export const Modal: React.FC<{
  width: number;
  enter: number;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}> = ({width, enter, title, description, footer, children}) => (
  <>
    <div style={{position: 'absolute', inset: 0, background: `rgba(0,0,0,${0.5 * enter})`}} />
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width,
        transform: `translate(-50%, -50%) scale(${0.96 + 0.04 * enter})`,
        opacity: enter,
        background: COLORS.surface,
        border: `1px solid ${COLORS.borderStrong}`,
        borderRadius: 12,
        boxShadow: '0 24px 60px rgba(0,0,0,.5)',
      }}
    >
      <div style={{padding: '18px 22px 6px'}}>
        <div style={{fontSize: 16, fontWeight: 600, color: COLORS.text}}>{title}</div>
        {description ? <div style={{fontSize: 13, color: COLORS.textMuted, marginTop: 4}}>{description}</div> : null}
      </div>
      <div style={{padding: '12px 22px'}}>{children}</div>
      {footer ? (
        <div style={{padding: '12px 22px 18px', display: 'flex', justifyContent: 'flex-end', gap: 8}}>{footer}</div>
      ) : null}
    </div>
  </>
);
