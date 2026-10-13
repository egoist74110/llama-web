import React from 'react';
import {ChevronRight, Copy, Square} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Bar, Btn, Chip, LwCard, PageHeader, StatusPill} from '../ui/lw';

// Replica of app/pages/index.vue and OverviewHero.vue.
// Native app coordinates (1440 x 810).
// Pure component: every visual state comes from props.

export const OVERVIEW_LAYOUT = {
  heroCard: {x: 840, y: 185},
  speedNumber: {x: 980, y: 155},
  speedCurve: {x: 1040, y: 235},
  requestsTile: {x: 320, y: 330},
  queuedStat: {x: 420, y: 365},
  recentEventsCard: {x: 320, y: 460},
  firstEvent: {x: 420, y: 495},
  apiBubble: {x: 1365, y: 42},
} as const;

export type OverviewModelStatus =
  | {
      state: 'loading';
      name: string;
      progress: number; // 0..100
      pulse?: number;
    }
  | {
      state: 'ready';
      name: string;
      file?: string;
      profile?: string;
      ctx?: number;
      quant?: string;
      vision?: boolean;
      uptime?: string;
      inflight?: number;
      speedTps?: number | string;
      promptTps?: number | string;
      curveProgress?: number; // 0..1 (progress of speed curve drawing)
    }
  | {
      state: 'empty';
    };

export type EventItem = {
  id: string;
  dot: 'ok' | 'warn' | 'err' | 'dim';
  text: string;
  time: string;
};

export type RequestItem = {
  id: string;
  time: string;
  source: 'local' | 'lan' | 'public';
  model: string;
  promptTokens: number;
  completionTokens: number;
  duration: string;
};

export type OverviewPageProps = {
  hero?: OverviewModelStatus;
  requests?: {
    inflight: number;
    queued: number;
    queuedModels?: string;
  };
  llamacpp?: {
    version: string;
    updateAvailable?: string;
  };
  publicAccess?: {
    connected: boolean;
    url?: string;
  };
  recentEvents?: readonly EventItem[];
  recentRequests?: readonly RequestItem[];
  apiUrl?: string;
};

const DEFAULT_LINE = '0,52 30,50 60,42 90,44 120,30 150,34 180,24 210,20 240,25 270,16 300,18 320,15';
const DEFAULT_AREA = '0,63.5 0,52 30,50 60,42 90,44 120,30 150,34 180,24 210,20 240,25 270,16 300,18 320,15 320,63.5';

const DEFAULT_EVENTS: readonly EventItem[] = [
  {id: '1', dot: 'ok', text: 'Qwen3-8B（长上下文）：加载中 → 运行中', time: '18:04:12'},
  {id: '2', dot: 'dim', text: 'Qwen3-8B（长上下文）：已停止 → 加载中', time: '18:03:55'},
  {id: '3', dot: 'ok', text: 'Cloudflare 隧道已连通', time: '18:00:02'},
];

const DEFAULT_REQUESTS: readonly RequestItem[] = [
  {id: 'r1', time: '18:04:22', source: 'local', model: 'Qwen3-8B', promptTokens: 520, completionTokens: 184, duration: '2.1 s'},
  {id: 'r2', time: '18:03:15', source: 'lan', model: 'Qwen3-8B', promptTokens: 1200, completionTokens: 340, duration: '4.8 s'},
];

export const OverviewPage: React.FC<OverviewPageProps> = ({
  hero = {
    state: 'ready',
    name: 'Qwen3-8B',
    file: 'X:\\models\\Qwen3-8B-Q4_K_M.gguf',
    profile: '长上下文',
    ctx: 131072,
    quant: 'Q4_K_M',
    vision: true,
    uptime: '已运行 3 分钟',
    inflight: 1,
    speedTps: '42.7',
    promptTps: '812',
    curveProgress: 1,
  },
  requests = {
    inflight: 1,
    queued: 0,
    queuedModels: '',
  },
  llamacpp = {
    version: 'b11146',
    updateAvailable: '发现新版 b11429',
  },
  publicAccess = {
    connected: true,
    url: 'https://llm.example.com/v1',
  },
  recentEvents = DEFAULT_EVENTS,
  recentRequests = DEFAULT_REQUESTS,
  apiUrl = 'http://192.168.1.10:5001/v1',
}) => {
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 20}}>
      {/* Header */}
      <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between'}}>
        <PageHeader
          title="总览"
          subtitle="请求到来时自动加载对应模型；这里看它现在在做什么。"
        />

        {/* API address capsule */}
        {apiUrl ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px',
              borderRadius: 10,
              background: COLORS.surfaceInset,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <span style={{fontSize: 12, color: COLORS.textFaint}}>API</span>
            <span style={{fontFamily: FONT.mono, fontSize: 13, color: COLORS.text}}>{apiUrl}</span>
            <Btn variant="ghost" icon={Copy} size="xs" />
          </div>
        ) : null}
      </div>

      {/* Hero Card */}
      <LwCard style={{padding: '20px 24px'}}>
        {hero.state === 'loading' ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
              <StatusPill kind="loading" label="加载中" pulse={hero.pulse ?? 1} />
              <span style={{fontSize: 12, color: COLORS.textFaint}}>大模型可能需要一分钟以上</span>
            </div>

            <div style={{fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: COLORS.text}}>
              {hero.name}
            </div>

            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              <Bar value={hero.progress / 100} tone="warn" height={8} />
              <div style={{fontFamily: FONT.sans, fontSize: 13, color: COLORS.textMuted}}>
                加载进度约 {Math.round(hero.progress)}%
              </div>
            </div>
          </div>
        ) : hero.state === 'ready' ? (
          <div style={{display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 36}}>
            {/* Left column */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <StatusPill kind="ready" label="运行中" />
                <span style={{fontSize: 12, color: COLORS.textFaint}}>
                  {hero.uptime ?? '已运行 3 分钟'} · 在途请求 {hero.inflight ?? 1}
                </span>
              </div>

              <div>
                <div style={{fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: COLORS.text}}>
                  {hero.name}
                </div>
                {hero.file ? (
                  <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint, marginTop: 4}}>
                    {hero.file}
                  </div>
                ) : null}
              </div>

              {/* Chips */}
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                {hero.profile ? <Chip>方案 · {hero.profile}</Chip> : null}
                {hero.ctx ? <Chip mono>ctx {hero.ctx}</Chip> : null}
                {hero.quant ? <Chip mono>{hero.quant}</Chip> : null}
                {hero.vision ? <Chip accent>视觉</Chip> : null}
              </div>

              {/* Buttons */}
              <div style={{display: 'flex', gap: 8, marginTop: 4}}>
                <Btn variant="outline" icon={Square} label="停止" size="sm" />
                <Btn variant="outline" label="查看输出" size="sm" />
              </div>
            </div>

            {/* Right column: Generation Speed */}
            <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10}}>
              <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between'}}>
                <div>
                  <div style={{fontSize: 12, color: COLORS.textFaint}}>正在生成</div>
                  <div style={{display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2}}>
                    <span
                      style={{
                        fontFamily: FONT.mono,
                        fontSize: 48,
                        fontWeight: 500,
                        lineHeight: 1.05,
                        letterSpacing: '-0.03em',
                        color: COLORS.accentText,
                      }}
                    >
                      {hero.speedTps ?? '–'}
                    </span>
                    <span style={{fontSize: 14, color: COLORS.textMuted}}>tokens/s</span>
                  </div>
                </div>

                <div style={{textAlign: 'right'}}>
                  <div style={{fontSize: 12, color: COLORS.textFaint}}>提示处理</div>
                  <div style={{fontFamily: FONT.mono, fontSize: 18, color: COLORS.text, marginTop: 2}}>
                    {hero.promptTps ?? 812} <span style={{fontSize: 12, color: COLORS.textFaint}}>t/s</span>
                  </div>
                </div>
              </div>

              {/* SVG Speed Curve */}
              <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
                <div style={{position: 'relative', width: '100%', height: 72}}>
                  <svg
                    viewBox="0 0 320 64"
                    preserveAspectRatio="none"
                    style={{display: 'block', width: '100%', height: 72}}
                  >
                    <line x1={0} y1={63.5} x2={320} y2={63.5} stroke={COLORS.border} strokeWidth={1} />
                    <g style={{clipPath: `inset(0 ${(1 - Math.max(0, Math.min(1, hero.curveProgress ?? 1))) * 100}% 0 0)`}}>
                      <polygon points={DEFAULT_AREA} fill={COLORS.accentSoft} />
                      <polyline
                        points={DEFAULT_LINE}
                        fill="none"
                        stroke={COLORS.accent}
                        strokeWidth={2}
                        strokeLinejoin="round"
                      />
                    </g>
                  </svg>
                </div>
                <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 11, color: COLORS.textFaint}}>
                  <span>40 秒前</span>
                  <span>现在</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Empty state */
          <div style={{padding: '14px 0'}}>
            <div style={{fontSize: 20, fontWeight: 600, color: COLORS.text}}>没有正在运行的模型。</div>
            <div style={{fontSize: 13, color: COLORS.textMuted, marginTop: 4}}>
              已启用 2 个模型；酒馆或其他客户端发来请求时会自动加载对应的模型。
            </div>
          </div>
        )}
      </LwCard>

      {/* Stat Tiles (3 cards) */}
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14}}>
        {/* Requests tile */}
        <LwCard style={{padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10}}>
          <div style={{fontSize: 12, color: COLORS.textFaint}}>请求</div>
          <div style={{display: 'flex', gap: 24}}>
            <div>
              <div style={{fontFamily: FONT.mono, fontSize: 22, fontWeight: 500, color: COLORS.text}}>
                {requests.inflight}
              </div>
              <div style={{fontSize: 12, color: COLORS.textFaint}}>在途</div>
            </div>
            <div>
              <div
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 22,
                  fontWeight: 500,
                  color: requests.queued > 0 ? COLORS.accentText : COLORS.text,
                }}
              >
                {requests.queued}
              </div>
              <div style={{fontSize: 12, color: COLORS.textFaint}}>排队切换</div>
            </div>
          </div>
          {requests.queuedModels ? (
            <div
              style={{
                fontSize: 12,
                color: COLORS.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {requests.queuedModels}
            </div>
          ) : null}
        </LwCard>

        {/* llama.cpp tile */}
        <LwCard style={{padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10}}>
          <div style={{fontSize: 12, color: COLORS.textFaint}}>llama.cpp</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <span style={{fontFamily: FONT.mono, fontSize: 22, fontWeight: 500, color: COLORS.text}}>
              {llamacpp.version}
            </span>
            {llamacpp.updateAvailable ? (
              <span style={{fontSize: 12, color: COLORS.accentText}}>{llamacpp.updateAvailable}</span>
            ) : null}
          </div>
          <div style={{display: 'flex', gap: 6}}>
            <Chip>可用</Chip>
          </div>
        </LwCard>

        {/* Public Access tile */}
        <LwCard style={{padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>公网访问</span>
            <span style={{fontSize: 12, color: COLORS.accentText, display: 'inline-flex', alignItems: 'center'}}>
              前往 <ChevronRight size={14} />
            </span>
          </div>
          <div>
            <StatusPill kind={publicAccess.connected ? 'ready' : 'stopped'} label={publicAccess.connected ? '隧道已连通' : '未开启'} />
          </div>
          {publicAccess.url ? (
            <div
              style={{
                fontFamily: FONT.mono,
                fontSize: 12,
                color: COLORS.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {publicAccess.url}
            </div>
          ) : null}
        </LwCard>
      </div>

      {/* Recent section (Recent Events + Recent Requests) */}
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14}}>
        {/* Recent Events */}
        <LwCard style={{display: 'flex', flexDirection: 'column'}}>
          <div
            style={{
              padding: '14px 18px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.text}}>最近事件</div>
            <Btn variant="ghost" label="全部" size="xs" />
          </div>

          <div style={{padding: '0 18px 14px', display: 'flex', flexDirection: 'column'}}>
            {recentEvents.map((e) => {
              const dotColor =
                e.dot === 'ok'
                  ? COLORS.ok
                  : e.dot === 'warn'
                    ? COLORS.warn
                    : e.dot === 'err'
                      ? COLORS.danger
                      : COLORS.textFaint;
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '14px 1fr auto',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '7px 0',
                    borderBottom: `1px solid rgba(255,255,255,0.03)`,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      marginTop: 6,
                      background: dotColor,
                    }}
                  />
                  <span style={{fontSize: 13, color: COLORS.text, wordBreak: 'break-word'}}>
                    {e.text}
                  </span>
                  <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
                    {e.time}
                  </span>
                </div>
              );
            })}
          </div>
        </LwCard>

        {/* Recent Requests */}
        <LwCard style={{display: 'flex', flexDirection: 'column'}}>
          <div
            style={{
              padding: '14px 18px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.text}}>最近请求</div>
            <Btn variant="ghost" label="全部" size="xs" />
          </div>

          <div style={{padding: '0 18px 14px', display: 'flex', flexDirection: 'column'}}>
            {recentRequests.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '60px 50px 1fr 100px 50px',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 0',
                  fontSize: 12,
                  borderBottom: `1px solid rgba(255,255,255,0.03)`,
                }}
              >
                <span style={{fontFamily: FONT.mono, color: COLORS.textFaint}}>{r.time}</span>
                <Chip accent={r.source === 'public'} style={{height: 20, fontSize: 11}}>
                  {r.source === 'local' ? '本机' : r.source === 'lan' ? '局域网' : '公网'}
                </Chip>
                <span style={{color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                  {r.model}
                </span>
                <span style={{fontFamily: FONT.mono, color: COLORS.textMuted, textAlign: 'right'}}>
                  {r.promptTokens} / {r.completionTokens}
                </span>
                <span style={{fontFamily: FONT.mono, color: COLORS.textFaint, textAlign: 'right'}}>
                  {r.duration}
                </span>
              </div>
            ))}
          </div>
        </LwCard>
      </div>
    </div>
  );
};
