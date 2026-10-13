import React from 'react';
import {ArrowRight, Check, Circle, CircleCheck, LoaderCircle} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {SIDEBAR_W} from '../ui/AppShell';
import {AppCard, Btn, PageHeader} from '../ui/lw';

// Replica of app/components/PublicWizard.vue, PublicCfRun.vue, and PublicStatus.vue.
// Native app coordinates: 1440 x 810.
// Pure component: all visual states are controlled by props.

const CONTENT_X = SIDEBAR_W + 44; // 280
const CONTAINER_W = 1116;
const NAV_W = 180;
const CARDS_X = CONTENT_X + NAV_W + 24; // 484
const CARDS_W = CONTAINER_W - NAV_W - 24; // 912

// Option cards layout within AppCard:
// inner width = CARDS_W - 40 = 872. gap = 10. width per card = (872 - 20) / 3 = 284.
const OPT_W = 284;
const OPT_H = 118;
const OPT_CENTER_Y = 386; // measured on the rendered preview

export const PUBLIC_WIZARD_LAYOUT = {
  card: {x: CARDS_X, y: 172, w: CARDS_W, h: 460},
  progressHeader: {x: CARDS_X + 20, y: 242},
  stepIndicator: {x: CARDS_X + CARDS_W - 20 - 50, y: 242},
  progressBar: {x: CARDS_X + 20, y: 264, w: CARDS_W - 40, h: 4},

  // 3 Option cards centers
  optApi: {x: CARDS_X + 20 + OPT_W / 2, y: OPT_CENTER_Y}, // {x: 646, y: 373}
  optManual: {x: CARDS_X + 20 + OPT_W + 10 + OPT_W / 2, y: OPT_CENTER_Y}, // {x: 940, y: 373}
  optQuick: {x: CARDS_X + 20 + (OPT_W + 10) * 2 + OPT_W / 2, y: OPT_CENTER_Y}, // {x: 1234, y: 373}

  nextBtn: {x: 547, y: 500},

  // Execution steps positions
  stepTunnel: {x: CARDS_X + 36, y: 326},
  stepIngress: {x: CARDS_X + 36, y: 358},
  stepDns: {x: CARDS_X + 36, y: 390},
  statusListening: {x: CARDS_X + 36, y: 432},
  statusConnected: {x: CARDS_X + 36, y: 462},
} as const;

export type WizardPhase = 'select' | 'running' | 'connected';
export type WizardPathOption = 'api' | 'manual' | 'quick';

export type PublicWizardProps = {
  phase?: WizardPhase;
  selectedOption?: WizardPathOption | null;
  hoverOption?: WizardPathOption | null;
  runningStep?: number; // 0: none/tunnel running, 1: tunnel done, 2: ingress done, 3: dns done
  statusConnected?: boolean;

  // Feedback
  apiCardPressed?: number;
  quickCardPressed?: number;
  nextBtnPressed?: number;
  spinDeg?: number; // spinner rotation, driven by the caller's frame

  // Frame toggle
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

export const PublicWizard: React.FC<PublicWizardProps> = ({
  phase = 'select',
  selectedOption = 'api',
  hoverOption = null,
  runningStep = 0,
  statusConnected = false,
  apiCardPressed = 0,
  quickCardPressed = 0,
  nextBtnPressed = 0,
  spinDeg = 0,
  bare = false,
}) => {
  const isSelect = phase === 'select';
  const isConnected = phase === 'connected' || statusConnected;

  // Step information
  const stepIndex = isConnected ? 4 : phase === 'running' ? 3 : 2; // 0-indexed: 2 is step 3
  const stepTitle = isConnected ? '连接' : phase === 'running' ? '预览并执行' : '选择方式';
  const stepNumberText = `第 ${stepIndex + 1} 步 / 共 5 步`;

  const cardContent = (
    <AppCard
      title="公网访问"
      hint="经 Cloudflare 隧道从外网使用这里的模型。只开放 /v1/*，每个请求都要带 API key；界面和管理接口不会暴露。"
      style={{width: CARDS_W}}
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
        {/* Progress Header */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
          <div style={{display: 'flex', alignItems: 'baseline', justifyContent: 'space-between'}}>
            <span style={{fontSize: 14, fontWeight: 500, color: COLORS.text}}>
              {stepTitle}
            </span>
            <span style={{fontSize: 12, color: COLORS.textMuted}}>
              {stepNumberText}
            </span>
          </div>

          {/* 5-segment Progress Bar */}
          <div style={{display: 'flex', gap: 4, height: 4}}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: '100%',
                  borderRadius: 999,
                  background: i <= stepIndex ? COLORS.accent : COLORS.surfaceInset,
                  border: i <= stepIndex ? 'none' : `1px solid ${COLORS.border}`,
                }}
              />
            ))}
          </div>
        </div>

        {/* Phase 1: Step 3 Path Options */}
        {isSelect ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <p style={{margin: 0, fontSize: 13, color: COLORS.text, lineHeight: 1.5}}>
              有域名选前两种：效果一样，都需要一个已经添加到 Cloudflare 的域名。没有域名可以先用临时地址试用。
            </p>

            {/* 3 Option Cards */}
            <div style={{display: 'flex', gap: 10}}>
              {/* Option 1: 一键完成（推荐） */}
              {(() => {
                const isSelected = selectedOption === 'api';
                const isHovered = hoverOption === 'api';
                const pressed = apiCardPressed;
                return (
                  <div
                    style={{
                      width: OPT_W,
                      height: OPT_H,
                      boxSizing: 'border-box',
                      padding: 12,
                      borderRadius: 10,
                      border: `1px solid ${
                        isSelected || isHovered ? COLORS.accent : COLORS.border
                      }`,
                      background: isSelected
                        ? 'rgba(79,91,213,0.08)'
                        : isHovered
                          ? 'rgba(255,255,255,0.02)'
                          : COLORS.surfaceInset,
                      boxShadow: isHovered ? `0 0 10px ${COLORS.accentSoft}` : 'none',
                      transform: `scale(${1 - 0.02 * pressed})`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      {isSelected ? (
                        <CircleCheck size={16} color={COLORS.accent} strokeWidth={2} />
                      ) : (
                        <Circle size={16} color={COLORS.textMuted} strokeWidth={2} />
                      )}
                      <span style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>
                        一键完成（推荐）
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        color: COLORS.textMuted,
                        lineHeight: 1.45,
                      }}
                    >
                      提供一个 Cloudflare API token，llama-web 代你建隧道、写入口规则和 DNS 记录。每次改动前都会先给你看预览。
                    </span>
                  </div>
                );
              })()}

              {/* Option 2: 我在 Cloudflare 网页上自己建 */}
              {(() => {
                const isSelected = selectedOption === 'manual';
                const isHovered = hoverOption === 'manual';
                return (
                  <div
                    style={{
                      width: OPT_W,
                      height: OPT_H,
                      boxSizing: 'border-box',
                      padding: 12,
                      borderRadius: 10,
                      border: `1px solid ${
                        isSelected || isHovered ? COLORS.accent : COLORS.border
                      }`,
                      background: isSelected
                        ? 'rgba(79,91,213,0.08)'
                        : isHovered
                          ? 'rgba(255,255,255,0.02)'
                          : COLORS.surfaceInset,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      {isSelected ? (
                        <CircleCheck size={16} color={COLORS.accent} strokeWidth={2} />
                      ) : (
                        <Circle size={16} color={COLORS.textMuted} strokeWidth={2} />
                      )}
                      <span style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>
                        我在 Cloudflare 网页上自己建
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        color: COLORS.textMuted,
                        lineHeight: 1.45,
                      }}
                    >
                      照着图文教程在 Cloudflare 后台点几下，最后把隧道 token 粘贴回来。不需要 API token。
                    </span>
                  </div>
                );
              })()}

              {/* Option 3: 没有域名，用临时地址 */}
              {(() => {
                const isSelected = selectedOption === 'quick';
                const isHovered = hoverOption === 'quick';
                const pressed = quickCardPressed;
                return (
                  <div
                    style={{
                      width: OPT_W,
                      height: OPT_H,
                      boxSizing: 'border-box',
                      padding: 12,
                      borderRadius: 10,
                      border: `1px solid ${
                        isSelected || isHovered ? COLORS.accent : COLORS.border
                      }`,
                      background: isSelected
                        ? 'rgba(79,91,213,0.08)'
                        : isHovered
                          ? 'rgba(79,91,213,0.06)'
                          : COLORS.surfaceInset,
                      boxShadow: isHovered
                        ? `0 0 14px rgba(79,91,213,0.3)`
                        : 'none',
                      transform: `scale(${1 - 0.02 * pressed})`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      {isSelected ? (
                        <CircleCheck size={16} color={COLORS.accent} strokeWidth={2} />
                      ) : (
                        <Circle size={16} color={isHovered ? COLORS.accent : COLORS.textMuted} strokeWidth={2} />
                      )}
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: isHovered ? COLORS.accentText : COLORS.text,
                        }}
                      >
                        没有域名，用临时地址
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        color: COLORS.textMuted,
                        lineHeight: 1.45,
                      }}
                    >
                      不需要域名，也不需要 Cloudflare 账号。连通后得到一个 trycloudflare.com 的随机地址，每次启动都会变，只适合试用。
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Cloudflared status note */}
            <p style={{margin: 0, fontSize: 12, color: COLORS.textMuted}}>
              本机 cloudflared：已就绪
            </p>

            {/* Next button */}
            <div>
              <Btn
                size="sm"
                variant="primary"
                icon={ArrowRight}
                label="下一步"
                pressed={nextBtnPressed}
              />
            </div>
          </div>
        ) : (
          /* Phase 2 & 3: Execution progress & Connected */
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            {/* Step execution checklist */}
            <div
              style={{
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                padding: '12px 14px',
                background: COLORS.surfaceInset,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {[
                {id: 'tunnel', label: '隧道', state: runningStep >= 1 ? 'done' : runningStep === 0 ? 'running' : 'pending'},
                {id: 'ingress', label: '入口规则', state: runningStep >= 2 ? 'done' : runningStep === 1 ? 'running' : 'pending'},
                {id: 'dns', label: 'DNS 记录', state: runningStep >= 3 ? 'done' : runningStep === 2 ? 'running' : 'pending'},
              ].map((st) => {
                const isDone = st.state === 'done';
                const isRunning = st.state === 'running';
                return (
                  <div key={st.id} style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
                    {isDone ? (
                      <Check size={16} color={COLORS.ok} strokeWidth={2.2} />
                    ) : isRunning ? (
                      <LoaderCircle size={16} color={COLORS.accent} strokeWidth={2} style={{transform: `rotate(${spinDeg}deg)`}} />
                    ) : (
                      <Circle size={16} color={COLORS.textFaint} strokeWidth={1.5} />
                    )}
                    <span style={{fontWeight: 500, color: COLORS.text}}>{st.label}</span>
                    <span
                      style={{
                        fontSize: 12,
                        color: isDone ? COLORS.ok : isRunning ? COLORS.accentText : COLORS.textFaint,
                        marginLeft: 4,
                      }}
                    >
                      {isDone ? '完成' : isRunning ? '进行中' : '等待'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Connection and listener status */}
            <div
              style={{
                borderTop: `1px solid ${COLORS.border}`,
                paddingTop: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {/* Row 1: 入口监听 */}
              <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
                <Check size={15} color={COLORS.ok} strokeWidth={2.2} />
                <span style={{width: 68, color: COLORS.textMuted}}>公网入口</span>
                <span style={{color: COLORS.ok}}>正在监听 127.0.0.1:8080</span>
              </div>

              {/* Row 2: 隧道连接 */}
              <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
                {isConnected ? (
                  <>
                    <Check size={15} color={COLORS.ok} strokeWidth={2.2} />
                    <span style={{width: 68, color: COLORS.textMuted}}>隧道</span>
                    <span style={{color: COLORS.ok, fontWeight: 500}}>已连通（4 条连接）</span>
                  </>
                ) : (
                  <>
                    <LoaderCircle size={15} color={COLORS.textMuted} strokeWidth={2} />
                    <span style={{width: 68, color: COLORS.textMuted}}>隧道</span>
                    <span style={{color: COLORS.textMuted}}>正在连接 Cloudflare……</span>
                  </>
                )}
              </div>
            </div>

            {/* Completion hint */}
            {runningStep >= 3 ? (
              <p style={{margin: 0, fontSize: 12, color: COLORS.ok}}>
                完成：llm.example.com 已接到这台电脑。下一步等隧道连通；DNS 第一次生效可能需要一两分钟。
              </p>
            ) : null}
          </div>
        )}
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

          {/* Main Card */}
          {cardContent}
        </div>
      </div>
    </div>
  );
};
