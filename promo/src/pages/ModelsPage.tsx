import React from 'react';
import {
  Check,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {SIDEBAR_W} from '../ui/AppShell';
import {Btn, Chip, Icon, Input, LwCard, PageHeader, StatusPill, TierPill} from '../ui/lw';

// Replica of app/pages/models.vue, DiscoverPanel.vue, and ModelCard.vue, dark mode.
// Pure component: every visual state comes from props.
// Native app coordinates: 1440 x 810.

const CONTENT_X = SIDEBAR_W + 44; // 280
const CONTAINER_W = 1116;

export const MODELS_LAYOUT = {
  tabEnabled: {x: CONTENT_X + 48, y: 118},
  tabDiscover: {x: CONTENT_X + 135, y: 118},
  // In Discover tab, Card 1's "启用" button center:
  enableBtn: {x: CONTENT_X + 548 - 18 - 38, y: 186 + 210 - 16 - 14}, // {x: 772, y: 366}
  // In Enabled tab, Row 1's "启动" button center:
  startBtn: {x: CONTENT_X + CONTAINER_W - 20 - 38, y: 150 + 44}, // {x: 1338, y: 194}
  // In Enabled tab, Row 1's "编辑" pencil button center:
  editBtn: {x: CONTENT_X + CONTAINER_W - 20 - 76 - 8 - 28 - 8 - 14, y: 150 + 44}, // {x: 1242, y: 194}
} as const;

export type ModelsPageState = {
  tab: 'discover' | 'enabled';
  qwenEnabled?: boolean;
  qwenState?: 'stopped' | 'loading' | 'ready';
  qwenProfile?: string;
  enablePressed?: number;
  startPressed?: number;
  editPressed?: number;
};

export const ModelsPage: React.FC<ModelsPageState> = ({
  tab,
  qwenEnabled = false,
  qwenState = 'stopped',
  qwenProfile = '默认',
  enablePressed = 0,
  startPressed = 0,
  editPressed = 0,
}) => {
  return (
    <div style={{width: CONTAINER_W, display: 'flex', flexDirection: 'column', gap: 18}}>
      <PageHeader
        title="模型"
        subtitle="客户端用模型名（或「名字:方案」）调用；第一个请求到来时会自动加载。"
      />

      {/* Toolbar */}
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, height: 32}}>
        {/* Segmented tabs */}
        <div
          style={{
            display: 'inline-flex',
            gap: 2,
            padding: 3,
            borderRadius: 10,
            background: COLORS.surfaceInset,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <div
            style={{
              height: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              borderRadius: 7,
              fontSize: 13,
              fontWeight: tab === 'enabled' ? 500 : 400,
              color: tab === 'enabled' ? COLORS.text : COLORS.textMuted,
              background: tab === 'enabled' ? COLORS.surface : 'transparent',
              boxShadow: tab === 'enabled' ? '0 1px 2px rgba(0,0,0,.25)' : 'none',
              cursor: 'pointer',
            }}
          >
            <span>已启用</span>
            <span style={{fontFamily: FONT.mono, fontSize: 11, color: COLORS.textFaint}}>
              {qwenEnabled ? 2 : 1}
            </span>
          </div>
          <div
            style={{
              height: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              borderRadius: 7,
              fontSize: 13,
              fontWeight: tab === 'discover' ? 500 : 400,
              color: tab === 'discover' ? COLORS.text : COLORS.textMuted,
              background: tab === 'discover' ? COLORS.surface : 'transparent',
              boxShadow: tab === 'discover' ? '0 1px 2px rgba(0,0,0,.25)' : 'none',
              cursor: 'pointer',
            }}
          >
            <span>扫描发现</span>
          </div>
        </div>

        {/* Right actions */}
        <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
          <Btn variant="outline" icon={FolderOpen} label="添加目录" size="sm" />
          <div style={{width: 220}}>
            <Input height={30} placeholder="筛选模型">
              <span style={{display: 'flex', alignItems: 'center', gap: 6, color: COLORS.textFaint}}>
                <Icon icon={Search} size={14} />
                <span>筛选模型</span>
              </span>
            </Input>
          </div>
        </div>
      </div>

      {/* Content depending on tab */}
      {tab === 'discover' ? (
        <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16}}>
            <p style={{margin: 0, fontSize: 12, color: COLORS.textFaint}}>
              模型目录里还没启用的 .gguf 文件。只读取文件头，不会加载模型。 上次扫描：12:30
            </p>
            <Btn variant="outline" icon={RefreshCw} label="重新扫描" size="sm" />
          </div>

          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
            {/* Card 1: Qwen3-8B */}
            <LwCard style={{padding: '16px 18px', height: 210, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
              <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                  <span style={{fontSize: 14, fontWeight: 600, color: COLORS.text}}>Qwen3-8B-Q4_K_M.gguf</span>
                  <Chip>内嵌聊天模板</Chip>
                </div>
                <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
                  X:\models\Qwen3-8B-Q4_K_M.gguf
                </div>

                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4, fontSize: 12}}>
                  <div>
                    <div style={{color: COLORS.textFaint}}>架构 · 参数量</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>qwen3 · 8.2B</div>
                  </div>
                  <div>
                    <div style={{color: COLORS.textFaint}}>量化 · 大小</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>Q4_K_M · 4.7 GB</div>
                  </div>
                  <div>
                    <div style={{color: COLORS.textFaint}}>原生上下文</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>40K</div>
                  </div>
                </div>

                <div style={{fontSize: 12, color: COLORS.textMuted, marginTop: 2}}>
                  同目录有 1 个 mmproj、0 个草稿模型，启用后可在模型编辑里选择（不会自动选）
                </div>
              </div>

              <div style={{display: 'flex', justifyContent: 'flex-end'}}>
                <Btn
                  variant="primary"
                  icon={qwenEnabled ? Check : Plus}
                  label={qwenEnabled ? '已启用' : '启用'}
                  size="sm"
                  pressed={enablePressed}
                />
              </div>
            </LwCard>

            {/* Card 2: Gemma-3-12B */}
            <LwCard style={{padding: '16px 18px', height: 210, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
              <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                  <span style={{fontSize: 14, fontWeight: 600, color: COLORS.text}}>Gemma-3-12B-it-Q4_K_M.gguf</span>
                </div>
                <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
                  X:\models\Gemma-3-12B-it-Q4_K_M.gguf
                </div>

                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4, fontSize: 12}}>
                  <div>
                    <div style={{color: COLORS.textFaint}}>架构 · 参数量</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>gemma3 · 12.0B</div>
                  </div>
                  <div>
                    <div style={{color: COLORS.textFaint}}>量化 · 大小</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>Q4_K_M · 7.3 GB</div>
                  </div>
                  <div>
                    <div style={{color: COLORS.textFaint}}>原生上下文</div>
                    <div style={{fontFamily: FONT.mono, color: COLORS.text, marginTop: 2}}>32K</div>
                  </div>
                </div>
              </div>

              <div style={{display: 'flex', justifyContent: 'flex-end'}}>
                <Btn variant="primary" icon={Plus} label="启用" size="sm" />
              </div>
            </LwCard>
          </div>
        </div>
      ) : (
        <LwCard style={{overflow: 'hidden'}}>
          {/* Row 1: Qwen3-8B */}
          <div
            style={{
              padding: '16px 20px',
              height: 88,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: `1px solid ${COLORS.border}`,
            }}
          >
            {/* Left */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <span style={{fontSize: 15, fontWeight: 600, color: COLORS.text}}>Qwen3-8B</span>
                <StatusPill
                  kind={qwenState === 'ready' ? 'ready' : qwenState === 'loading' ? 'loading' : 'stopped'}
                  label={qwenState === 'ready' ? '运行中' : qwenState === 'loading' ? '加载中' : '已停止'}
                />
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <Chip mono>Q4_K_M</Chip>
                <Chip accent icon={ImageIcon}>视觉</Chip>
                <Chip mono>预估占用 5.1 GB</Chip>
                <TierPill tier="fit" label="放得下" />
              </div>
              <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
                X:\models\Qwen3-8B-Q4_K_M.gguf
              </div>
            </div>

            {/* Right actions */}
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <span style={{fontSize: 12, color: COLORS.textFaint}}>配置方案</span>
                <Input select width={100} height={28}>
                  <span style={{fontSize: 13}}>{qwenProfile}</span>
                </Input>
              </div>
              <Btn variant="outline" icon={Pencil} size="sm" pressed={editPressed} />
              <Btn variant="outline" icon={Trash2} size="sm" />
              <Btn
                variant={qwenState === 'ready' ? 'outline' : 'primary'}
                icon={qwenState === 'ready' ? Square : Play}
                label={qwenState === 'ready' ? '停止' : '启动'}
                size="sm"
                pressed={startPressed}
                style={{minWidth: 76}}
              />
            </div>
          </div>

          {/* Row 2: Gemma-3-12B */}
          <div
            style={{
              padding: '16px 20px',
              height: 88,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {/* Left */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <span style={{fontSize: 15, fontWeight: 600, color: COLORS.text}}>Gemma-3-12B</span>
                <StatusPill kind="stopped" label="已停止" />
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <Chip mono>Q4_K_M</Chip>
                <Chip>无 mmproj</Chip>
                <Chip mono>预估占用 7.8 GB</Chip>
                <TierPill tier="fit" label="放得下" />
              </div>
              <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
                X:\models\Gemma-3-12B-it-Q4_K_M.gguf
              </div>
            </div>

            {/* Right actions */}
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <span style={{fontSize: 12, color: COLORS.textFaint}}>配置方案</span>
                <Input select width={100} height={28}>
                  <span style={{fontSize: 13}}>默认</span>
                </Input>
              </div>
              <Btn variant="outline" icon={Pencil} size="sm" />
              <Btn variant="outline" icon={Trash2} size="sm" />
              <Btn variant="primary" icon={Play} label="启动" size="sm" style={{minWidth: 76}} />
            </div>
          </div>
        </LwCard>
      )}
    </div>
  );
};
