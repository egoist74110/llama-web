import React from 'react';
import {Check, Copy, Pencil, Plus, Save, Trash2} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Bar, Btn, Chip, Drawer, Input, LW, Radio, Seg, StatusPill, TierPill} from '../ui/lw';

// Replica of app/components/ModelEditor.vue, ProfileForm.vue, and MemoryEstimate.vue.
// Edit drawer on the right (USlideover), dark mode.
// Pure component: every visual state comes from props.

export const MODEL_EDITOR_LAYOUT = {
  drawer: {x: 864, y: 0, w: 576, h: 810},
  contextModeSelect: {x: 1266, y: 210},
  contextInput: {x: 1367, y: 210},
  runtimeSelect: {x: 1321, y: 262},
  extraArgsInput: {x: 960, y: 460},
  saveBtn: {x: 1370, y: 766},
  copyBtn: {x: 1385, y: 525},
} as const;

export const MODEL_PROFILES_LAYOUT = {
  drawer: {x: 864, y: 0, w: 576, h: 810},
  tabProfiles: {x: 1056, y: 98},
  cardDefault: {x: 1152, y: 220},
  cardLongCtx: {x: 1152, y: 276},
  cardNoThinking: {x: 1152, y: 332},
  setCurrentBtn: {x: 928, y: 366},
  createBtn: {x: 996, y: 366},
  duplicateBtn: {x: 1052, y: 366},
  renameBtn: {x: 1114, y: 366},
  removeBtn: {x: 1172, y: 366},
} as const;

export type ProfileItem = {
  name: string;
  isCurrent?: boolean;
  running?: boolean;
  selected?: boolean;
};

const DEFAULT_PROFILES: readonly ProfileItem[] = [
  {name: '默认', isCurrent: true, selected: true},
  {name: '长上下文', isCurrent: false, selected: false},
  {name: '关思考', isCurrent: false, selected: false},
];

export type ModelEditorDrawerProps = {
  open?: boolean;
  enter?: number;
  modelName?: string;
  tab?: 'files' | 'profiles' | 'params';
  // Profiles tab props:
  profiles?: readonly ProfileItem[];
  cardEnters?: readonly [number, number, number]; // 0..1 per card for staggered entrance
  setCurrentPressed?: number;
  createPressed?: number;
  duplicatePressed?: number;
  renamePressed?: number;
  removePressed?: number;
  // Params tab props:
  contextMode?: 'inherit' | 'custom';
  contextValue?: number | string;
  runtimeValue?: string;
  runtimeSelectPressed?: number;
  tier?: 'fit' | 'risk' | 'nofit';
  extraArgs?: React.ReactNode;
  extraArgsString?: string;
  savePressed?: number;
  modeSelectPressed?: number;
  contextInputPressed?: number;
  extraArgsPressed?: number;
};

export const ModelEditorDrawer: React.FC<ModelEditorDrawerProps> = ({
  open = true,
  enter = 1,
  modelName = 'Qwen3-8B',
  tab = 'params',
  profiles = DEFAULT_PROFILES,
  cardEnters = [1, 1, 1],
  setCurrentPressed = 0,
  createPressed = 0,
  duplicatePressed = 0,
  renamePressed = 0,
  removePressed = 0,
  contextMode = 'inherit',
  contextValue = 32768,
  runtimeValue = '跟随上一层（b11146）',
  runtimeSelectPressed = 0,
  tier = 'fit',
  extraArgs = null,
  extraArgsString = '',
  savePressed = 0,
  modeSelectPressed = 0,
  contextInputPressed = 0,
  extraArgsPressed = 0,
}) => {
  if (!open || enter <= 0.001) return null;

  const tabIndex = tab === 'files' ? 0 : tab === 'profiles' ? 1 : 2;

  // Derive memory estimate texts and values based on tier
  const isCustom = contextMode === 'custom';
  const ctxNum = Number(contextValue) || 32768;

  let barValue = 0.52;
  let barTone: 'accent' | 'warn' | 'err' = 'accent';
  let tierLabel = '放得下';
  let summary = '预估需要 5.1 GB，当前可用 9.8 GB（52%）';
  let tierHint = '预估占用不到可用量的 85%。';

  if (tier === 'nofit' || ctxNum >= 131072) {
    barValue = 1.0;
    barTone = 'err';
    tierLabel = '放不下';
    summary = '预估需要 12.9 GB，当前可用 9.8 GB（132%）';
    tierHint = '预估占用超过了可用量。界面不会启动它，请换更小的模型 / 参数，或先停止其他模型。';
  } else if (tier === 'risk' || (ctxNum > 65536 && ctxNum < 131072)) {
    barValue = 0.88;
    barTone = 'warn';
    tierLabel = '有风险';
    summary = '预估需要 8.6 GB，当前可用 9.8 GB（88%）';
    tierHint = '预估占用在可用量的 85% – 100% 之间，余量很小，别的程序一占用就可能放不下。';
  } else if (ctxNum === 65536) {
    barValue = 0.69;
    barTone = 'accent';
    tierLabel = '放得下';
    summary = '预估需要 6.8 GB，当前可用 9.8 GB（69%）';
    tierHint = '预估占用不到可用量的 85%。';
  }

  // Derive command string
  const extraSuffix = extraArgsString ? ` ${extraArgsString}` : '';
  const commandPreview = `llama-server -m X:\\models\\${modelName}-Q4_K_M.gguf -c ${contextValue} --reasoning on${extraSuffix}`;

  return (
    <Drawer
      width={576}
      enter={enter}
      title={`编辑「${modelName}」`}
      description="文件和配置方案。保存后，下次加载时生效；正在运行的模型需要重启。"
      footer={
        tab === 'profiles' ? (
          <div style={{display: 'flex', justifyContent: 'flex-start', alignItems: 'center'}}>
            <Btn variant="danger" icon={Trash2} label="删除" size="sm" />
          </div>
        ) : (
          <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            <Btn variant="ghost" label="放弃修改" size="sm" />
            <Btn variant="primary" icon={Save} label="保存方案" size="sm" pressed={savePressed} />
          </div>
        )
      }
    >
      <div style={{padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12}}>
        {/* Tabs */}
        <Seg options={['文件', '配置方案', '参数']} active={tabIndex} height={28} />

        {tab === 'profiles' ? (
          /* ==================== 配置方案 TAB ==================== */
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <p style={{margin: 0, fontSize: 12, color: COLORS.textFaint, lineHeight: 1.5}}>
              一个模型可以有多个方案，例如不同的上下文长度。客户端用「模型名:方案名」直接调用；不带方案名时使用当前方案。
            </p>

            {/* Scheme cards */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              {profiles.map((p, idx) => {
                const cEnter = cardEnters ? cardEnters[idx] ?? 1 : 1;
                if (cEnter <= 0.001) return null;
                const isSelected = !!p.selected;
                return (
                  <div
                    key={p.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 14px',
                      borderRadius: 10,
                      background: COLORS.surface,
                      border: `1px solid ${isSelected ? COLORS.accent : COLORS.border}`,
                      boxShadow: isSelected ? `0 0 0 1px ${COLORS.accent}, ${LW.shadow}` : LW.shadow,
                      opacity: cEnter,
                      transform: `translateY(${(1 - cEnter) * 10}px)`,
                    }}
                  >
                    <Radio on={isSelected} />
                    <span style={{flex: 1, fontSize: 13, fontWeight: 500, color: COLORS.text}}>
                      {p.name}
                    </span>
                    {p.isCurrent ? <Chip accent>当前</Chip> : null}
                    {p.running ? <StatusPill kind="ready" label="这个方案正在运行" /> : null}
                  </div>
                );
              })}
            </div>

            {/* Action buttons */}
            <div style={{display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2}}>
              <Btn variant="outline" icon={Check} label="设为当前" size="sm" pressed={setCurrentPressed} />
              <Btn variant="outline" icon={Plus} label="新建" size="xs" pressed={createPressed} />
              <Btn variant="outline" icon={Copy} label="复制" size="xs" pressed={duplicatePressed} />
              <Btn variant="outline" icon={Pencil} label="重命名" size="xs" pressed={renamePressed} />
              <Btn variant="danger" icon={Trash2} label="删除" size="xs" pressed={removePressed} />
            </div>
          </div>
        ) : (
          /* ==================== 参数 TAB ==================== */
          <>
            {/* Profile select */}
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <span style={{fontSize: 12, color: COLORS.textFaint}}>正在编辑的方案</span>
              <Input select width={140} height={28}>
                <span style={{fontSize: 13}}>默认（当前）</span>
              </Input>
            </div>

            {/* Common Settings Header */}
            <div style={{fontSize: 13, fontWeight: 600, color: COLORS.textMuted, marginTop: 2}}>
              常用设置
            </div>

            {/* 1. 上下文长度 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '6px 0',
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>上下文长度</div>
                <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2, lineHeight: 1.4}}>
                  --ctx-size。能记住的最多 token 数，越大越占显存；0 表示用模型自带的长度。
                </div>
              </div>

              <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                {/* Mode Select */}
                <div
                  style={{
                    width: 76,
                    height: 28,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 8px',
                    borderRadius: 6,
                    background: COLORS.surfaceInset,
                    border: `1px solid ${COLORS.borderStrong}`,
                    fontSize: 12,
                    color: COLORS.text,
                    cursor: 'pointer',
                    transform: `scale(${1 - 0.05 * modeSelectPressed})`,
                  }}
                >
                  <span>{isCustom ? '自定义' : '继承'}</span>
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={COLORS.textFaint} strokeWidth={2}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </div>

                {/* Value box */}
                {isCustom ? (
                  <div
                    style={{
                      width: 110,
                      height: 28,
                      boxSizing: 'border-box',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 8px',
                      borderRadius: 6,
                      background: COLORS.surfaceInset,
                      border: `1px solid ${COLORS.borderStrong}`,
                      fontFamily: FONT.mono,
                      fontSize: 12,
                      color: COLORS.text,
                      transform: `scale(${1 - 0.05 * contextInputPressed})`,
                    }}
                  >
                    {contextValue}
                  </div>
                ) : (
                  <span style={{width: 110, fontSize: 12, color: COLORS.textMuted}}>
                    继承：{contextValue}
                  </span>
                )}
              </div>
            </div>

            {/* 2. llama.cpp 版本 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '8px 0',
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>llama.cpp 版本</div>
                <div
                  style={{
                    width: 194,
                    height: 28,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 8px',
                    borderRadius: 6,
                    background: COLORS.surfaceInset,
                    border: `1px solid ${COLORS.borderStrong}`,
                    fontSize: 12,
                    color: COLORS.text,
                    transform: `scale(${1 - 0.05 * runtimeSelectPressed})`,
                  }}
                >
                  <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                    {runtimeValue}
                  </span>
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={COLORS.textFaint} strokeWidth={2}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </div>
              </div>
              <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
                只列这台电脑能用的版本。选定的版本不存在时，启动会改用最新的官方版本，并留下提示。
              </div>
            </div>

            {/* 3. 显存预估 */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2}}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>显存预估</span>
                <TierPill tier={tier} label={tierLabel} />
              </div>

              <Bar value={barValue} tone={barTone} height={6} />

              <div style={{fontSize: 12, color: COLORS.text, lineHeight: 1.4}}>
                {summary}
              </div>
              <div style={{fontSize: 11, color: COLORS.textMuted, lineHeight: 1.35}}>
                {tierHint}
              </div>
              <div style={{fontSize: 11, color: COLORS.textFaint}}>
                依据：按模型文件和参数估算
              </div>
            </div>

            {/* 4. 额外参数 */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4}}>
              <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>额外参数</span>
              <div
                style={{
                  minHeight: 32,
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  borderRadius: 6,
                  background: COLORS.surfaceInset,
                  border: `1px solid ${COLORS.borderStrong}`,
                  fontFamily: FONT.mono,
                  fontSize: 12,
                  color: COLORS.text,
                  transform: `scale(${1 - 0.03 * extraArgsPressed})`,
                }}
              >
                {extraArgs ?? (extraArgsString ? (
                  extraArgsString
                ) : (
                  <span style={{color: COLORS.textFaint}}>--flag value --other-flag</span>
                ))}
              </div>
              <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
                按命令行规则填写，例如 --jinja --spec-type draft-mtp。和上面表单里同一个参数重复时，以这里为准。
              </div>
            </div>

            {/* 5. 命令预览 */}
            <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4}}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>命令预览</span>
                <Btn variant="outline" icon={Copy} label="复制" size="xs" />
              </div>

              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: COLORS.surfaceInset,
                  border: `1px solid ${COLORS.border}`,
                  fontFamily: FONT.mono,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: COLORS.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {commandPreview}
              </pre>

              <div style={{fontSize: 11, color: COLORS.textFaint}}>
                使用的 llama.cpp：{runtimeValue === '我的分支' ? '我的分支' : 'b11146'}
              </div>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
};
