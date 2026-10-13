import React from 'react';
import {Download, History, Plus, RefreshCw, Trash2} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {SIDEBAR_W} from '../ui/AppShell';
import {AppCard, Btn, Chip, PageHeader, Radio, Switch} from '../ui/lw';

// Replica of app/pages/settings.vue, SettingsLlamacpp.vue, and LlamacppUpdateControls.vue.
// Native app coordinates: 1440 x 810. Pure component: every visual state comes from props.

const CONTENT_X = SIDEBAR_W + 44; // 280
const CONTAINER_W = 1116;
const NAV_W = 180;
const CARDS_X = CONTENT_X + NAV_W + 24; // 484
const CARDS_W = CONTAINER_W - NAV_W - 24; // 912

export const SETTINGS_LAYOUT = {
  card: {x: CARDS_X, y: 252, w: CARDS_W, h: 366},
  addVersionBtn: {x: CARDS_X + CARDS_W - 20 - 42, y: 274}, // {x: 1334, y: 274}
  currentChip: {x: CARDS_X + 115, y: 446}, // {x: 599, y: 446}
  updateNotice: {x: CARDS_X + 225, y: 446}, // {x: 709, y: 446}
  updateDownloadBtn: {x: CARDS_X + CARDS_W - 20 - 50 - 8 - 44, y: 446}, // {x: 1274, y: 446}
  rollbackBtn: {x: CARDS_X + CARDS_W - 20 - 50 - 8 - 56, y: 488}, // {x: 1262, y: 488}
  customBranchRow: {x: CARDS_X + 130, y: 530}, // {x: 614, y: 530}
} as const;

export type SettingsRuntimePageProps = {
  hasCustomBranch?: boolean;
  addVersionPressed?: number;
  rollbackPressed?: number;
  downloadPressed?: number;
  highlightCurrent?: number; // 0..1 subtle emphasis
  highlightAvailable?: number; // 0..1 subtle emphasis
  highlightRollback?: number; // 0..1 subtle emphasis
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

export const SettingsRuntimePage: React.FC<SettingsRuntimePageProps> = ({
  hasCustomBranch = false,
  addVersionPressed = 0,
  rollbackPressed = 0,
  downloadPressed = 0,
  highlightCurrent = 0,
  highlightAvailable = 0,
  highlightRollback = 0,
}) => {
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
            const isActive = s.id === 'llama';
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
          {/* 1. 模型目录 Card (Title-level Placeholder) */}
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
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>模型目录</div>
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>X:\models · 4 个模型</span>
          </div>

          {/* 2. 本机 Card (Title-level Placeholder) */}
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
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>本机</div>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>NVIDIA GeForce RTX 4070 · 12 GB 显存</span>
          </div>

          {/* 3. llama.cpp 版本 Card (Focused Core Feature) */}
          <AppCard
            title="llama.cpp 版本"
            hint="每天检查一次，自动更新默认关闭；开启后会自动下载并使用新版。保留最近 2 个版本，可以随时回退。"
            actions={
              <Btn
                size="xs"
                variant="outline"
                icon={Plus}
                label="添加版本"
                pressed={addVersionPressed}
              />
            }
          >
            <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
              {/* LlamacppUpdateControls row */}
              <div
                style={{
                  paddingBottom: 12,
                  borderBottom: `1px solid ${COLORS.border}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <Switch on={false} />
                    <span style={{fontSize: 13, color: COLORS.text}}>自动更新</span>
                  </div>
                  <Btn size="xs" variant="outline" icon={RefreshCw} label="检查更新" />
                </div>
                <div style={{fontSize: 12, color: COLORS.textFaint, lineHeight: 1.4}}>
                  默认关闭。每天检查一次，关闭时只在版本号旁提示；开启后自动下载并使用新版。重启不会重复检查，手动检查可随时进行。
                </div>
              </div>

              {/* Status note */}
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                <div style={{fontSize: 13}}>
                  <span style={{color: COLORS.textFaint}}>状态</span>
                  <span style={{marginLeft: 8, color: COLORS.text}}>已就绪：b11146</span>
                </div>
                <div style={{fontSize: 12, color: COLORS.textFaint}}>
                  自动更新已关闭，每天检查并在版本号旁提示，可手动更新。
                </div>
              </div>

              {/* Version list */}
              <ul style={{listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column'}}>
                {/* Row 1: Current version b11146 */}
                <li
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '9px 8px',
                    borderRadius: 6,
                    borderBottom: `1px solid ${COLORS.border}`,
                    background:
                      highlightCurrent > 0
                        ? `rgba(79, 91, 213, ${0.12 * highlightCurrent})`
                        : highlightAvailable > 0
                          ? `rgba(79, 91, 213, ${0.08 * highlightAvailable})`
                          : 'transparent',
                    boxShadow:
                      highlightCurrent > 0
                        ? `0 0 0 1px rgba(79, 91, 213, ${0.4 * highlightCurrent})`
                        : 'none',
                  }}
                >
                  <Radio on />
                  <span style={{fontFamily: FONT.mono, fontSize: 13, fontWeight: 600, color: COLORS.text}}>
                    b11146
                  </span>
                  <Chip
                    accent
                    style={{
                      height: 22,
                      fontSize: 12,
                      transform: highlightCurrent > 0 ? `scale(${1 + 0.05 * highlightCurrent})` : undefined,
                    }}
                  >
                    当前
                  </Chip>
                  <span
                    style={{
                      fontSize: 12,
                      color: COLORS.accentText,
                      fontWeight: 500,
                      opacity: highlightAvailable > 0 ? 1 : 0.9,
                    }}
                  >
                    发现新版 b11429
                  </span>

                  <div style={{flex: 1}} />

                  <Btn
                    size="xs"
                    variant="primary"
                    icon={Download}
                    label="下载更新"
                    pressed={downloadPressed}
                    style={{
                      boxShadow:
                        highlightAvailable > 0
                          ? `0 0 0 2px ${COLORS.accentSoft}`
                          : undefined,
                    }}
                  />
                  <Btn size="xs" variant="ghost" icon={Trash2} disabled label="删除" />
                </li>

                {/* Row 2: Rollback version b10980 */}
                <li
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '9px 8px',
                    borderRadius: 6,
                    borderBottom: hasCustomBranch ? `1px solid ${COLORS.border}` : 'none',
                    background:
                      highlightRollback > 0
                        ? `rgba(79, 91, 213, ${0.1 * highlightRollback})`
                        : 'transparent',
                    boxShadow:
                      highlightRollback > 0
                        ? `0 0 0 1px rgba(79, 91, 213, ${0.35 * highlightRollback})`
                        : 'none',
                  }}
                >
                  <Radio on={false} />
                  <span style={{fontFamily: FONT.mono, fontSize: 13, color: COLORS.textMuted}}>
                    b10980
                  </span>

                  <div style={{flex: 1}} />

                  <Btn
                    size="xs"
                    variant="outline"
                    icon={History}
                    label="回退到此版本"
                    pressed={rollbackPressed}
                    style={{
                      borderColor: highlightRollback > 0 ? COLORS.accent : undefined,
                      color: highlightRollback > 0 ? COLORS.text : undefined,
                    }}
                  />
                  <Btn size="xs" variant="ghost" icon={Trash2} label="删除" />
                </li>

                {/* Row 3: Custom branch (conditionally displayed) */}
                {hasCustomBranch ? (
                  <li
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '9px 8px',
                      borderRadius: 6,
                      background: 'rgba(74, 222, 128, 0.06)',
                    }}
                  >
                    <Radio on={false} />
                    <span style={{fontFamily: FONT.mono, fontSize: 13, fontWeight: 500, color: COLORS.text}}>
                      我的分支
                    </span>
                    <Chip style={{height: 22, fontSize: 12}}>
                      手动添加
                    </Chip>

                    <div style={{flex: 1}} />

                    <Btn size="xs" variant="outline" icon={History} label="切换到此版本" />
                    <Btn size="xs" variant="ghost" icon={Trash2} label="删除" />
                  </li>
                ) : null}
              </ul>

              {/* Bottom footnotes */}
              <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2}}>
                <div style={{fontSize: 12, color: COLORS.textFaint}}>
                  最新的官方版本不能删除；手动添加的版本不会被自动清理，也不会自动更新。
                </div>
                <div style={{fontSize: 12, color: COLORS.textFaint}}>
                  切换后，正在运行的模型继续使用原来的版本，卸载后再加载才会用新选的版本。
                </div>
              </div>
            </div>
          </AppCard>

          {/* 4. 全局默认参数 Card (Title-level Placeholder) */}
          <div
            style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: '12px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: 0.45,
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>全局默认参数</div>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>上下文 32768 · 思考模式 开启</span>
          </div>

          {/* 5. 图片预处理 Card (Title-level Placeholder) */}
          <div
            style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: '12px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: 0.4,
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>图片预处理</div>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>已开启 · 最长边 896px</span>
          </div>

          {/* 6. 端口与调度 Card (Title-level Placeholder) */}
          <div
            style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              padding: '12px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: 0.35,
            }}
          >
            <div style={{fontSize: 14, fontWeight: 600, color: COLORS.textMuted}}>端口与调度</div>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>端口 5001 · 范围 5002–5020</span>
          </div>
        </div>
      </div>
    </div>
  );
};
