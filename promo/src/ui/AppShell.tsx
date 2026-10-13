import React from 'react';
import {Box, Compass, LayoutDashboard, MessageSquare, Plug, SlidersHorizontal, Text} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Icon, LW, Seg, StatusPill} from './lw';

// Replica of the real app shell (app/layouts/default.vue + AppSidebar.vue), dark mode,
// at native size APP_W x APP_H. Pages render into `children`; drawers / modals / toasts go
// into `overlay`, which covers the whole viewport like the real Nuxt UI overlays.

export const APP_W = 1440;
export const APP_H = 810;
export const SIDEBAR_W = 236;

export type NavKey = 'guide' | 'overview' | 'models' | 'connections' | 'chat' | 'logs' | 'settings';

const NAV: readonly {key: NavKey; label: string; icon: LucideIcon}[] = [
  {key: 'guide', label: '新手引导', icon: Compass},
  {key: 'overview', label: '总览', icon: LayoutDashboard},
  {key: 'models', label: '模型', icon: Box},
  {key: 'connections', label: '接入', icon: Plug},
  {key: 'chat', label: '对话', icon: MessageSquare},
  {key: 'logs', label: '日志', icon: Text},
  {key: 'settings', label: '设置', icon: SlidersHorizontal},
];

export type Serving =
  | {state: 'idle'}
  | {state: 'loading'; model: string; percent: number; pulse: number}
  | {state: 'ready'; model: string; tps: string; generating: boolean};

export type AppShellProps = {
  active: NavKey;
  showGuide?: boolean;
  counts?: Partial<Record<NavKey, number>>;
  serving?: Serving;
  llamacpp?: {tag: string | null; newTag?: string};
  // Vertical scroll of the page content (px, native).
  scrollY?: number;
  // Highlight a nav item as hovered / about to be clicked (0..1).
  navHover?: {key: NavKey; amount: number};
  children?: React.ReactNode;
  overlay?: React.ReactNode;
};

const BrandMark: React.FC = () => (
  <div
    style={{
      width: 30,
      height: 30,
      borderRadius: 9,
      background: COLORS.accent,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}
  >
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13h3.5l2.2-6 3.6 11 2.3-5H20" />
    </svg>
  </div>
);

const ServingCard: React.FC<{serving: Serving}> = ({serving}) => {
  const pill =
    serving.state === 'idle' ? (
      <StatusPill kind="stopped" label="空闲" />
    ) : serving.state === 'loading' ? (
      <StatusPill kind="loading" label="加载中" pulse={serving.pulse} />
    ) : (
      <StatusPill kind="ready" label="运行中" />
    );
  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: LW.radiusCard,
        boxShadow: LW.shadow,
        padding: '12px 14px',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <span style={{fontSize: 12, color: COLORS.textFaint}}>正在服务</span>
        {pill}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: COLORS.text,
          marginTop: 8,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {serving.state === 'idle' ? '没有运行的模型' : serving.model}
      </div>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4}}>
        {serving.state === 'idle' ? (
          <span style={{fontSize: 12, color: COLORS.textFaint}}>— 等待请求</span>
        ) : serving.state === 'loading' ? (
          <>
            <span style={{fontFamily: FONT.mono, fontSize: 20, color: COLORS.accentText}}>{serving.percent}%</span>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>加载进度</span>
          </>
        ) : (
          <>
            <span style={{fontFamily: FONT.mono, fontSize: 20, color: COLORS.accentText}}>{serving.tps}</span>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>{serving.generating ? 't/s 生成中' : 't/s 上次'}</span>
          </>
        )}
      </div>
    </div>
  );
};

export const AppShell: React.FC<AppShellProps> = ({
  active,
  showGuide = false,
  counts = {},
  serving = {state: 'idle'},
  llamacpp = {tag: 'b11146'},
  scrollY = 0,
  navHover,
  children,
  overlay,
}) => (
  <div
    style={{
      width: APP_W,
      height: APP_H,
      position: 'relative',
      overflow: 'hidden',
      background: COLORS.bg,
      fontFamily: FONT.sans,
      fontSize: LW.base,
      lineHeight: 1.5,
      color: COLORS.text,
      display: 'flex',
    }}
  >
    {/* Sidebar */}
    <div
      style={{
        width: SIDEBAR_W,
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '18px 14px',
        borderRight: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px 14px'}}>
        <BrandMark />
        <div>
          <div style={{fontSize: 15, fontWeight: 600}}>llama-web</div>
          <div style={{fontSize: 12, color: COLORS.textFaint}}>LLM 网关 · llama.cpp 管理</div>
        </div>
      </div>
      {NAV.filter((n) => n.key !== 'guide' || showGuide).map((n) => {
        const on = n.key === active;
        const hover = navHover && navHover.key === n.key ? navHover.amount : 0;
        return (
          <div
            key={n.key}
            style={{
              height: 40,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 12px',
              borderRadius: 9,
              fontSize: 14,
              fontWeight: on ? 500 : 400,
              color: on ? COLORS.text : COLORS.textMuted,
              background: on ? COLORS.surface : `rgba(255,255,255,${0.04 * hover})`,
              border: `1px solid ${on ? COLORS.border : 'transparent'}`,
              boxShadow: on ? LW.shadow : 'none',
            }}
          >
            <Icon icon={n.icon} size={16} color={on ? COLORS.accentText : COLORS.textMuted} />
            <span style={{flex: 1}}>{n.label}</span>
            {counts[n.key] ? (
              <span style={{fontSize: 12, color: COLORS.textFaint, fontFamily: FONT.mono}}>{counts[n.key]}</span>
            ) : null}
          </div>
        );
      })}
      <div style={{flex: 1}} />
      <ServingCard serving={serving} />
      <div style={{fontSize: 12, color: COLORS.textFaint, padding: '12px 6px 0', display: 'flex', flexDirection: 'column', gap: 6}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
          <span style={{width: 7, height: 7, borderRadius: 999, background: COLORS.ok}} />
          实时连接正常
        </div>
        <div style={{fontFamily: FONT.mono}}>
          llama.cpp {llamacpp.tag ?? '未安装'}
          {llamacpp.newTag ? <span style={{color: COLORS.accentText, fontFamily: FONT.sans}}> 发现新版 {llamacpp.newTag}</span> : null}
        </div>
        <div style={{fontFamily: FONT.mono}}>llama-web v1.0.0</div>
      </div>
      <Seg options={['中文', 'EN']} active={0} height={26} style={{display: 'flex', marginTop: 10}} />
      <Seg options={['系统', '浅色', '深色']} active={0} height={26} style={{display: 'flex', marginTop: 6}} />
    </div>

    {/* Main */}
    <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
      <div
        style={{
          padding: '28px 44px 48px',
          transform: `translateY(${-scrollY}px)`,
        }}
      >
        <div style={{position: 'relative', maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22}}>
          {children}
        </div>
      </div>
    </div>

    {overlay ? <div style={{position: 'absolute', inset: 0}}>{overlay}</div> : null}
  </div>
);
