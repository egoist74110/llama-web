import React from 'react';
import {Play, Plus, Search, TriangleAlert} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Btn, Input, Modal, Seg} from '../ui/lw';

// Replica of app/components/RuntimeAddModal.vue (添加版本弹窗), dark mode.
// Pure component: all states controlled by props.
// Native app coordinates: 1440 x 810.

const MODAL_W = 560;

export const RUNTIME_ADD_LAYOUT = {
  modal: {x: 720, y: 405, w: MODAL_W, h: 420},
  tabGithub: {x: 852, y: 362},
  urlInput: {x: 720, y: 429},
  previewBtn: {x: 947, y: 535},
  confirmRunBtn: {x: 906, y: 525},
  labelInput: {x: 720, y: 540},
  addBtn: {x: 947, y: 594},
} as const;

export type RuntimeAddModalProps = {
  open?: boolean;
  enter?: number;
  step?: 'source' | 'confirm' | 'preview';
  kind?: 'dir' | 'archive' | 'github';
  url?: React.ReactNode;
  urlString?: string;
  label?: React.ReactNode;
  labelString?: string;
  tabGithubPressed?: number;
  previewBtnPressed?: number;
  confirmBtnPressed?: number;
  addBtnPressed?: number;
};

export const RuntimeAddModal: React.FC<RuntimeAddModalProps> = ({
  open = true,
  enter = 1,
  step = 'source',
  kind = 'github',
  url,
  urlString = 'https://github.com/example/llama.cpp-fork',
  label,
  labelString = '我的分支',
  tabGithubPressed = 0,
  previewBtnPressed = 0,
  confirmBtnPressed = 0,
  addBtnPressed = 0,
}) => {
  if (!open || enter <= 0.001) return null;

  const isPreview = step === 'preview';
  const isConfirm = step === 'confirm';

  return (
    <Modal
      width={MODAL_W}
      enter={enter}
      title={isPreview ? '确认添加' : '添加 llama.cpp 版本'}
      description={
        isConfirm
          ? undefined
          : '从一个文件夹、压缩包或 GitHub 发布页添加一个 llama.cpp 版本，复制到 data/runtime 里使用，不会改动原文件。'
      }
      footer={
        step === 'source' ? (
          <>
            <Btn size="sm" variant="ghost" label="取消" />
            <Btn
              size="sm"
              variant="primary"
              icon={Search}
              label="预览"
              pressed={previewBtnPressed}
            />
          </>
        ) : step === 'confirm' ? (
          <>
            <Btn size="sm" variant="ghost" label="返回" />
            <Btn
              size="sm"
              variant="primary"
              icon={Play}
              label="我明白，继续预览"
              pressed={confirmBtnPressed}
            />
          </>
        ) : (
          <>
            <Btn size="sm" variant="ghost" label="取消" />
            <Btn
              size="sm"
              variant="primary"
              icon={Plus}
              label="添加"
              pressed={addBtnPressed}
            />
          </>
        )
      }
    >
      {step === 'source' ? (
        /* ================= 步骤 1: 选择来源 ================= */
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          {/* Segmented Control */}
          <Seg
            options={['选择目录', '选择压缩包', 'GitHub 地址']}
            active={kind === 'dir' ? 0 : kind === 'archive' ? 1 : 2}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              transform: kind === 'github' && tabGithubPressed > 0 ? `scale(${1 - 0.02 * tabGithubPressed})` : undefined,
            }}
          />

          {/* Input field */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <label style={{fontSize: 12, fontWeight: 500, color: COLORS.textMuted}}>
              GitHub 地址
            </label>
            <Input mono width="100%" height={32} focused>
              {url ?? (
                <span style={{fontFamily: FONT.mono, fontSize: 13, color: COLORS.text}}>
                  {urlString}
                </span>
              )}
            </Input>
            <p style={{margin: 0, fontSize: 12, color: COLORS.textFaint, lineHeight: 1.4}}>
              只接受 https://github.com/ 开头的仓库或某个 Release 页面；会按这台电脑挑一个合适的构建下载。
            </p>
          </div>
        </div>
      ) : step === 'confirm' ? (
        /* ================= 步骤 2: 运行确认 ================= */
        <div
          style={{
            borderRadius: 10,
            border: `1px solid ${COLORS.borderStrong}`,
            background: COLORS.surfaceInset,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <TriangleAlert size={16} color={COLORS.warn} />
            <span style={{fontSize: 14, fontWeight: 500, color: COLORS.text}}>
              这会运行你选的程序
            </span>
          </div>
          <p style={{margin: 0, fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5}}>
            为了读出版本号，添加之前会先运行一次所选的 llama-server（带 --version，限时 10 秒）。只添加你信任的来源。
          </p>
          <div style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint, wordBreak: 'break-all'}}>
            {urlString}
          </div>
        </div>
      ) : (
        /* ================= 步骤 3: 预览与确认 ================= */
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          {/* Metadata definition grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 14px',
              fontSize: 13,
            }}
          >
            <span style={{color: COLORS.textMuted}}>来源</span>
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.text, wordBreak: 'break-all'}}>
              {urlString}
            </span>
            <span style={{color: COLORS.textMuted}}>大小</span>
            <span style={{color: COLORS.text}}>142 MB，18 个文件</span>
            <span style={{color: COLORS.textMuted}}>版本</span>
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.text}}>b11400-custom</span>
          </div>

          {/* SHA-256 Digest Card */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <span style={{fontSize: 12, fontWeight: 500, color: COLORS.textMuted}}>SHA-256</span>
            <div
              style={{
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.surfaceInset,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{fontSize: 12, color: COLORS.text}}>llama-server</div>
              <div style={{fontFamily: FONT.mono, fontSize: 11, color: COLORS.textFaint, wordBreak: 'break-all'}}>
                e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
              </div>
              <div style={{fontSize: 12, color: COLORS.ok, fontWeight: 500, marginTop: 2}}>
                与发布页公布的一致
              </div>
            </div>
          </div>

          {/* Display Name Input */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <label style={{fontSize: 12, fontWeight: 500, color: COLORS.textMuted}}>
              显示名称
            </label>
            <Input width="100%" height={32} focused>
              {label ?? (
                <span style={{fontSize: 13, color: COLORS.text}}>
                  {labelString}
                </span>
              )}
            </Input>
          </div>
        </div>
      )}
    </Modal>
  );
};
