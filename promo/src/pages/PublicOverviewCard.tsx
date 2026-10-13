import React from 'react';
import {Ban, Check, Copy, Eye, Plus, Power, Route} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {SIDEBAR_W} from '../ui/AppShell';
import {AppCard, Btn, Chip, PageHeader} from '../ui/lw';

// Replica of app/components/PublicOverview.vue, PublicAddresses.vue, and PublicKeys.vue.
// Native app coordinates: 1440 x 810.
// Pure component: every visual state comes from props.

const CONTENT_X = SIDEBAR_W + 44; // 280
const CONTAINER_W = 1116;
const NAV_W = 180;
const CARDS_X = CONTENT_X + NAV_W + 24; // 484
const CARDS_W = CONTAINER_W - NAV_W - 24; // 912

export const PUBLIC_OVERVIEW_LAYOUT = {
  card: {x: CARDS_X, y: 172, w: CARDS_W, h: 480},

  // Status section
  statusSection: {x: CARDS_X + 20, y: 236},

  // Address section
  addressSection: {x: CARDS_X + 20, y: 318},
  addressUrl: {x: 617, y: 438},
  copyAddressBtn: {x: 748, y: 438},
  v1Chip: {x: CARDS_X + 310, y: 358},
  checkOkText: {x: CARDS_X + 45, y: 382},

  // Keys section
  keysSection: {x: CARDS_X + 20, y: 406},
  keyPhone: {x: 580, y: 585},
  keyPhoneMasked: {x: CARDS_X + 110, y: 462},
  keyServer: {x: 580, y: 647},
  keyServerMasked: {x: CARDS_X + 110, y: 522},

  // Actions
  addAddressBtn: {x: CARDS_X + 20 + 50, y: 574},
  rerunBtn: {x: CARDS_X + 135 + 50, y: 574},
  closeBtn: {x: CARDS_X + 245 + 50, y: 574},
} as const;

export type PublicOverviewCardProps = {
  highlightAddress?: number; // 0..1 emphasis
  showV1Chip?: boolean;
  addressPressed?: number;
  copyPressed?: number;
  keysShown?: number; // 0..2: how many API keys have appeared
  bare?: boolean;
};

const TOC_SECTIONS = [
  {id: 'dirs', label: '模型目录'},
  {id: 'system', label: '本机'},
  {id: 'llama', label: 'llama.cpp 版本'},
  {id: 'defaults', label: '全局默认参数'},
  {id: 'image', label: '图片预处理'},
  {id: 'server', label: '端口与调度'},
  {id: 'public', label: '公网访问'},
  {id: 'mirror', label: '镜像加速'},
  {id: 'about', label: '关于 llama-web'},
  {id: 'import', label: '导入与导出'},
] as const;

export const PublicOverviewCard: React.FC<PublicOverviewCardProps> = ({
  highlightAddress = 0,
  showV1Chip = true,
  addressPressed = 0,
  copyPressed = 0,
  keysShown = 2,
  bare = false,
}) => {
  const cardContent = (
    <AppCard
      title="公网访问"
      hint="经 Cloudflare 隧道从外网使用这里的模型。只开放 /v1/*，每个请求都要带 API key；界面和管理接口不会暴露。"
      style={{width: CARDS_W}}
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
        {/* Section 1: 状态 */}
        <section style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          <h3 style={{margin: 0, fontSize: 13, fontWeight: 500, color: COLORS.text}}>
            状态
          </h3>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
            <span style={{width: 68, color: COLORS.textMuted}}>隧道方式</span>
            <span style={{color: COLORS.text}}>自有域名</span>
          </div>

          <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
              <Check size={14} color={COLORS.ok} strokeWidth={2.2} />
              <span style={{width: 68, color: COLORS.textMuted}}>公网入口</span>
              <span style={{color: COLORS.ok}}>正在监听 127.0.0.1:8080</span>
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
              <Check size={14} color={COLORS.ok} strokeWidth={2.2} />
              <span style={{width: 68, color: COLORS.textMuted}}>隧道</span>
              <span style={{color: COLORS.ok, fontWeight: 500}}>已连通（4 条连接）</span>
            </div>
          </div>
        </section>

        {/* Section 2: 客户端地址 */}
        <section
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div>
            <h3 style={{margin: 0, fontSize: 13, fontWeight: 500, color: COLORS.text}}>
              客户端地址
            </h3>
            <p style={{margin: '2px 0 0', fontSize: 12, color: COLORS.textMuted}}>
              Base URL 填其中一个，再带上 API key。
            </p>
          </div>

          {/* Address Line */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: highlightAddress > 0.01 ? 'rgba(79, 91, 213, 0.14)' : COLORS.surfaceInset,
                  border: `1px solid ${
                    highlightAddress > 0.01 ? COLORS.accent : COLORS.border
                  }`,
                  boxShadow: highlightAddress > 0.01 ? `0 0 12px ${COLORS.accentSoft}` : 'none',
                  transform: `scale(${1 - 0.02 * addressPressed})`,
                }}
              >
                <code
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 13,
                    fontWeight: 500,
                    color: highlightAddress > 0.01 ? COLORS.accentText : COLORS.text,
                    userSelect: 'none',
                  }}
                >
                  https://llm.example.com/v1
                </code>
              </div>

              {/* Copy button */}
              <Btn
                size="xs"
                variant="ghost"
                icon={Copy}
                pressed={copyPressed}
              />

              {/* Annotation Chip: 只开放 /v1/* */}
              {showV1Chip ? (
                <Chip accent style={{marginLeft: 4}}>
                  只开放 /v1/*
                </Chip>
              ) : null}
            </div>

            {/* Check result */}
            <div style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.ok, paddingLeft: 4}}>
              <Check size={12} color={COLORS.ok} strokeWidth={2.2} />
              <span>通（142 毫秒）</span>
            </div>
          </div>
        </section>

        {/* Section 3: API key */}
        <section
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div>
            <h3 style={{margin: 0, fontSize: 13, fontWeight: 500, color: COLORS.text}}>
              API key
            </h3>
            <p style={{margin: '2px 0 0', fontSize: 12, color: COLORS.textMuted}}>
              公网请求用 Authorization: Bearer &lt;key&gt; 鉴权。key 明文保存在 data/secrets.json，这里默认打码显示。吊销后立即失效。
            </p>
          </div>

          {/* Key List */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4}}>
            {/* Key 1: 手机 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: 8,
                background: COLORS.surfaceInset,
                border: `1px solid ${COLORS.border}`,
                opacity: Math.min(1, Math.max(0, keysShown)),
              }}
            >
              <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <span style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>手机</span>
                  <span
                    style={{
                      padding: '1px 7px',
                      borderRadius: 999,
                      background: 'rgba(74,222,128,0.12)',
                      color: COLORS.ok,
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    可用
                  </span>
                </div>
                <div style={{display: 'flex', alignItems: 'baseline', gap: 8}}>
                  <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textMuted}}>
                    lw-sec-••••••••••••3a9f
                  </span>
                  <span style={{fontSize: 11, color: COLORS.textFaint}}>
                    创建于 2026/10/12 14:20:00
                  </span>
                </div>
              </div>

              {/* Key actions */}
              <div style={{display: 'flex', alignItems: 'center', gap: 4}}>
                <Btn size="xs" variant="ghost" icon={Eye} label="查看" />
                <Btn size="xs" variant="ghost" icon={Copy} label="复制" />
                <Btn size="xs" variant="danger" icon={Ban} label="吊销" />
              </div>
            </div>

            {/* Key 2: server-1 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: 8,
                background: COLORS.surfaceInset,
                border: `1px solid ${COLORS.border}`,
                opacity: Math.min(1, Math.max(0, keysShown - 1)),
              }}
            >
              <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <span style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>server-1</span>
                  <span
                    style={{
                      padding: '1px 7px',
                      borderRadius: 999,
                      background: 'rgba(74,222,128,0.12)',
                      color: COLORS.ok,
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    可用
                  </span>
                </div>
                <div style={{display: 'flex', alignItems: 'baseline', gap: 8}}>
                  <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textMuted}}>
                    lw-sec-••••••••••••8b2e
                  </span>
                  <span style={{fontSize: 11, color: COLORS.textFaint}}>
                    创建于 2026/10/13 09:15:00
                  </span>
                </div>
              </div>

              {/* Key actions */}
              <div style={{display: 'flex', alignItems: 'center', gap: 4}}>
                <Btn size="xs" variant="ghost" icon={Eye} label="查看" />
                <Btn size="xs" variant="ghost" icon={Copy} label="复制" />
                <Btn size="xs" variant="danger" icon={Ban} label="吊销" />
              </div>
            </div>
          </div>
        </section>

        {/* Bottom Actions */}
        <div
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: 10,
            display: 'flex',
            gap: 8,
          }}
        >
          <Btn size="sm" variant="outline" icon={Plus} label="再加一个地址" />
          <Btn size="sm" variant="outline" icon={Route} label="重新运行引导" />
          <Btn size="sm" variant="danger" icon={Power} label="关闭公网访问" />
        </div>
      </div>
    </AppCard>
  );

  if (bare) {
    return cardContent;
  }

  return (
    <div style={{width: CONTAINER_W, display: 'flex', flexDirection: 'column', gap: 18}}>
      <PageHeader
        title="设置"
        subtitle="模型目录、全局默认参数、图片预处理、端口和调度、公网入口与 API key"
      />

      <div style={{display: 'flex', alignItems: 'flex-start', gap: 24}}>
        {/* Left TOC Nav */}
        <nav
          style={{
            width: NAV_W,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {TOC_SECTIONS.map((s) => {
            const isActive = s.id === 'public';
            return (
              <div
                key={s.id}
                style={{
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? COLORS.text : COLORS.textMuted,
                  background: isActive ? COLORS.surface : 'transparent',
                  border: isActive ? `1px solid ${COLORS.border}` : '1px solid transparent',
                  boxShadow: isActive ? '0 1px 2px rgba(0,0,0,.25)' : 'none',
                }}
              >
                {s.label}
              </div>
            );
          })}
        </nav>

        {/* Right Cards Stack */}
        <div style={{width: CARDS_W, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14}}>
          {/* Top placeholder card: 端口与调度 */}
          <div
            style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: '12px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: 0.5,
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>端口与调度</div>
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
              :8080 · 独立公网入口
            </span>
          </div>

          {/* Main Overview Card */}
          {cardContent}
        </div>
      </div>
    </div>
  );
};
