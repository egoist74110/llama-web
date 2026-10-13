import React from 'react';
import {Play} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Btn, Modal, Seg, Switch} from '../ui/lw';

// Replica of app/components/FirstStartDialog.vue (第一次启动确认弹窗), dark mode.
// Rendered in AppShell's overlay at native size 1440 x 810.

export const FIRST_START_LAYOUT = {
  modal: {x: 720, y: 405, w: 540, h: 370},
  confirmBtn: {x: 911, y: 595},
  cancelBtn: {x: 821, y: 595},
} as const;

export type FirstStartDialogProps = {
  open?: boolean;
  enter?: number;
  modelName?: string;
  ctxSize?: number | string;
  thinking?: boolean;
  vision?: boolean;
  mtp?: boolean;
  confirmPressed?: number;
  cancelPressed?: number;
};

export const FirstStartDialog: React.FC<FirstStartDialogProps> = ({
  open = true,
  enter = 1,
  modelName = 'Qwen3-8B',
  ctxSize = 32768,
  thinking = true,
  vision = true,
  mtp = false,
  confirmPressed = 0,
  cancelPressed = 0,
}) => {
  if (!open || enter <= 0.001) return null;

  return (
    <Modal
      width={540}
      enter={enter}
      title={`第一次启动「${modelName}」`}
      description="确认下面几项，之后可以随时在「编辑 → 参数」里改。"
      footer={
        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
          <Btn variant="ghost" label="取消" size="sm" pressed={cancelPressed} />
          <Btn
            variant="primary"
            icon={Play}
            label="确认并启动"
            size="sm"
            pressed={confirmPressed}
            style={{minWidth: 114}}
          />
        </div>
      }
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
        {/* 1. 上下文 */}
        <section style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <label style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>上下文</label>
          <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <div
              style={{
                width: 140,
                height: 28,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px',
                borderRadius: 6,
                background: COLORS.surfaceInset,
                border: `1px solid ${COLORS.borderStrong}`,
                fontFamily: FONT.mono,
                fontSize: 13,
                color: COLORS.text,
              }}
            >
              {ctxSize}
            </div>
            <span style={{fontFamily: FONT.mono, fontSize: 13, color: COLORS.textMuted}}>32K</span>
          </div>
          <p style={{margin: 0, fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            能记住的最多 token 数。0 表示用模型自带的长度，留空则不传此参数；额外参数里的上下文设置仍优先。
          </p>
        </section>

        {/* 2. 思考 */}
        <section style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>思考</span>
            <Seg options={['开', '关']} active={thinking ? 0 : 1} height={24} />
          </div>
          <p style={{margin: 0, fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            {thinking
              ? '模型先思考再回答。默认不限长度，可在「设置」中填写上限；关闭思考会保留已设上限。'
              : '不让模型思考，直接回答（更快）；保留已设上限，重新开启时继续使用。'}
          </p>
        </section>

        {/* 3. 视觉（看图） */}
        <section style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>视觉（看图）</span>
            <Switch on={vision} />
          </div>
          <p style={{margin: 0, fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            在同一个目录找到视觉文件
          </p>
          {vision ? (
            <div
              style={{
                height: 26,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 8px',
                borderRadius: 6,
                background: COLORS.surfaceInset,
                border: `1px solid ${COLORS.border}`,
                fontFamily: FONT.mono,
                fontSize: 11,
                color: COLORS.textMuted,
              }}
            >
              <span>mmproj-Qwen3-8B-f16.gguf · 840 MB</span>
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={COLORS.textFaint} strokeWidth={2}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          ) : null}
        </section>

        {/* 4. MTP */}
        <section style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <span style={{fontSize: 13, fontWeight: 600, color: COLORS.text}}>MTP（推测解码，更快的生成）</span>
            <Seg options={['开', '关']} active={mtp ? 0 : 1} height={24} />
          </div>
          <p style={{margin: 0, fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            先选择是否开启，再选择模式。模型是否支持自带 MTP 需要自行确认；文件扫描不会判断支持情况。
          </p>
        </section>
      </div>
    </Modal>
  );
};
