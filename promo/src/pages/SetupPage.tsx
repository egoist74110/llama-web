import React from 'react';
import {ArrowRight, Check, Cpu, Download, FolderOpen, Play, Plug, Plus, PlugZap} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {SIDEBAR_W} from '../ui/AppShell';
import {Btn, Icon, Input, LwCard, StatusText} from '../ui/lw';

// Replica of app/pages/setup.vue (新手引导), dark mode. Pure: every visual state comes from props.
// Rendered as the page content of <AppShell active="guide" showGuide>. Layout uses fixed geometry so
// chapters can aim the camera and the cursor at exact points (SETUP_LAYOUT, native app px).

const CONTENT_X = SIDEBAR_W + 44; // main padding-left
const CONTAINER_W = 760;
const CONTAINER_X = CONTENT_X + (1116 - CONTAINER_W) / 2; // centred in the 1116px content column

export const SETUP_LAYOUT = {
  x: CONTAINER_X,
  w: CONTAINER_W,
  modeLocal: {x: CONTAINER_X + 187, y: 160},
  modeGateway: {x: CONTAINER_X + 573, y: 160},
  step1: {top: 218, h: 232},
  step2: {top: 462, h: 120},
  step3: {top: 594, h: 108},
  step4: {top: 714, h: 100},
  // Click targets (centres).
  pickFolder: {x: CONTAINER_X + 121, y: 354},
  addAndScan: {x: CONTAINER_X + 697, y: 392},
  downloadBtn: {x: CONTAINER_X + 114, y: 550},
  enableBtn: {x: CONTAINER_X + 114, y: 682},
  // Gateway path steps.
  gwStep1: {top: 218, h: 120},
  gwStep2: {top: 350, h: 138},
  gwStep3: {top: 500, h: 172},
} as const;

export type LocalSetupState = {
  dir: {
    added: string | null; // path listed under 已添加的目录
    typed: React.ReactNode | null; // input contents
    focused: boolean;
    found: number | null;
    pickPressed?: number;
    addPressed?: number;
  };
  runtime: {status: 'none' | 'busy' | 'done'; line?: string; tag?: string; pressed?: number};
  enable: {done: number | null; pressed?: number};
};

export type GatewaySetupState = {
  done: [boolean, boolean, boolean];
  services?: string;
  models?: number;
};

type Props = {
  mode: 'local' | 'gateway';
  local: LocalSetupState;
  gateway?: GatewaySetupState;
  // Opacity of the step list (for the mode switch cross-fade).
  stepsOpacity?: number;
};

const StepBadge: React.FC<{n: number; done: boolean}> = ({n, done}) => (
  <div
    style={{
      width: 28,
      height: 28,
      borderRadius: 999,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: done ? COLORS.accent : COLORS.accentSoft,
      color: done ? '#fff' : COLORS.accentText,
      fontSize: 13,
      fontWeight: 600,
    }}
  >
    {done ? <Icon icon={Check} size={15} color="#fff" /> : n}
  </div>
);

const StepCard: React.FC<{
  n: number;
  top: number;
  h: number;
  title: string;
  hint: string;
  done: boolean;
  current: boolean;
  children?: React.ReactNode;
}> = ({n, top, h, title, hint, done, current, children}) => (
  <LwCard
    highlight={current}
    style={{position: 'absolute', left: 0, top, width: CONTAINER_W, height: h, boxSizing: 'border-box', padding: '18px 20px'}}
  >
    <div style={{display: 'flex', gap: 14}}>
      <StepBadge n={n} done={done} />
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontSize: 15, fontWeight: 600, lineHeight: '28px'}}>{title}</div>
        <div style={{fontSize: 12, color: COLORS.textFaint, lineHeight: 1.5}}>{hint}</div>
        <div style={{marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8}}>{children}</div>
      </div>
    </div>
  </LwCard>
);

const ModeCard: React.FC<{icon: typeof Cpu; title: string; hint: string; on: boolean; left: number}> = ({
  icon,
  title,
  hint,
  on,
  left,
}) => (
  <LwCard
    highlight={on}
    style={{position: 'absolute', left, top: 118, width: 374, height: 84, boxSizing: 'border-box', padding: '14px 16px'}}
  >
    <div style={{display: 'flex', gap: 10}}>
      <Icon icon={icon} size={18} color={on ? COLORS.accentText : COLORS.textMuted} style={{marginTop: 2}} />
      <div>
        <div style={{fontSize: 14, fontWeight: 600}}>{title}</div>
        <div style={{fontSize: 12, color: COLORS.textFaint, lineHeight: 1.5, marginTop: 2}}>{hint}</div>
      </div>
    </div>
  </LwCard>
);

export const SetupPage: React.FC<Props> = ({mode, local, gateway, stepsOpacity = 1}) => {
  const d = local.dir;
  const r = local.runtime;
  const dirDone = d.found !== null && d.found > 0;
  const runtimeDone = r.status === 'done';
  const enableDone = local.enable.done !== null;
  const currentLocal = !dirDone ? 1 : !runtimeDone ? 2 : !enableDone ? 3 : 4;
  const gw = gateway ?? {done: [false, false, false] as [boolean, boolean, boolean]};
  const currentGw = gw.done.findIndex((x) => !x) + 1;
  const anyProgress = dirDone || runtimeDone || gw.done.some(Boolean);
  const L = SETUP_LAYOUT;

  return (
    // Page content area is offset by AppShell's padding; we position absolutely from the viewport
    // origin, so undo that offset here.
    <div style={{position: 'absolute', left: CONTAINER_X - CONTENT_X, top: 0, width: CONTAINER_W, height: 800}}>
      <div style={{position: 'absolute', top: 0, width: CONTAINER_W}}>
        <div style={{fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em'}}>欢迎使用 llama-web</div>
        <div style={{fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.6}}>
          先选一种用法。每完成一步会自动打勾；可以先去别的页面看看，左侧的「新手引导」会一直在，直到你点「完成」或「先跳过」。
        </div>
      </div>

      {/* Coordinates below are relative to the viewport top minus the 28px page padding. */}
      <div style={{position: 'absolute', left: 0, top: -28, width: CONTAINER_W}}>
        <ModeCard
          icon={Cpu}
          title="运行本地模型"
          hint="用 llama.cpp 在这台电脑上跑 GGUF 模型，四步完成。"
          on={mode === 'local'}
          left={0}
        />
        <ModeCard
          icon={Plug}
          title="只接入外部 API"
          hint="不需要 llama.cpp：把 vLLM、Ollama、云端 API 等 OpenAI 兼容服务接进来，客户端只连 llama-web。"
          on={mode === 'gateway'}
          left={386}
        />

        <div style={{position: 'absolute', left: 0, top: 0, width: CONTAINER_W, opacity: stepsOpacity}}>
          {mode === 'local' ? (
            <>
              <StepCard
                n={1}
                top={L.step1.top}
                h={L.step1.h}
                title="选择模型目录"
                hint="模型 .gguf 文件所在的文件夹，会递归扫描子目录。可以添加多个，之后在设置页增删、停用。"
                done={dirDone}
                current={currentLocal === 1}
              >
                <div style={{height: 40}}>
                  {d.added ? (
                    <>
                      <div style={{fontSize: 12, color: COLORS.textFaint}}>已添加的目录</div>
                      <div style={{fontFamily: FONT.mono, fontSize: 13}}>{d.added}</div>
                    </>
                  ) : null}
                </div>
                <div>
                  <Btn icon={FolderOpen} label="选择文件夹…" pressed={d.pickPressed} />
                </div>
                <div style={{display: 'flex', gap: 8}}>
                  <Input mono focused={d.focused} placeholder="例如 X:\models 或 D:\AI\models">
                    {d.typed}
                  </Input>
                  <Btn variant="outline" label="添加并扫描" size="md" pressed={d.addPressed} />
                </div>
                <div style={{height: 20}}>
                  {d.found !== null ? <StatusText>在这个目录里找到 {d.found} 个模型文件。</StatusText> : null}
                </div>
              </StepCard>

              <StepCard
                n={2}
                top={L.step2.top}
                h={L.step2.h}
                title="安装 llama.cpp 运行库"
                hint="真正跑模型的程序，来自官方发布页，下载后会校验。只需要装一次。"
                done={runtimeDone}
                current={currentLocal === 2}
              >
                {r.status === 'done' ? (
                  <StatusText style={{lineHeight: '28px'}}>已安装：{r.tag}</StatusText>
                ) : (
                  <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <Btn
                      icon={Download}
                      label={r.status === 'busy' ? '正在下载…' : '下载并安装'}
                      pressed={r.pressed}
                      disabled={r.status === 'busy'}
                    />
                    <StatusText tone="muted">{r.status === 'busy' ? r.line : '还没有安装运行库。'}</StatusText>
                  </div>
                )}
              </StepCard>

              <StepCard
                n={3}
                top={L.step3.top}
                h={L.step3.h}
                title="启用模型"
                hint="在「模型」页的「扫描发现」里，点想用的模型旁的「启用」。"
                done={enableDone}
                current={currentLocal === 3}
              >
                {enableDone ? (
                  <StatusText>已启用 {local.enable.done} 个模型。</StatusText>
                ) : dirDone ? (
                  <div>
                    <Btn icon={ArrowRight} label="去启用模型" pressed={local.enable.pressed} />
                  </div>
                ) : (
                  <StatusText tone="muted">先完成第一步。</StatusText>
                )}
              </StepCard>

              <StepCard
                n={4}
                top={L.step4.top}
                h={L.step4.h}
                title="启动并确认"
                hint="在「模型」页点「启动」。第一次启动会问你思考、视觉、MTP 三个选项，之后就能用 API 或聊天客户端连接了。"
                done={false}
                current={currentLocal === 4}
              />
            </>
          ) : (
            <>
              <StepCard
                n={1}
                top={L.gwStep1.top}
                h={L.gwStep1.h}
                title="添加外部服务"
                hint="填写服务的地址（含 /v1）和它的 API key。名称会成为模型前缀，客户端用「名称-模型id」调用。"
                done={gw.done[0]}
                current={currentGw === 1}
              >
                {gw.done[0] ? (
                  <StatusText>已添加：{gw.services}</StatusText>
                ) : (
                  <div>
                    <Btn icon={Plus} label="添加外部服务" />
                  </div>
                )}
              </StepCard>
              <StepCard
                n={2}
                top={L.gwStep2.top}
                h={L.gwStep2.h}
                title="读取模型列表"
                hint="在「接入」页点「测试连接」，读出服务提供的模型；服务没有模型列表接口时可以手填模型 id。"
                done={gw.done[1]}
                current={currentGw === 2}
              >
                {gw.done[1] ? (
                  <StatusText>可用模型 {gw.models} 个。</StatusText>
                ) : (
                  <div>
                    <Btn variant="outline" icon={PlugZap} label={`测试连接 · ${gw.services ?? 'Strata'}`} />
                  </div>
                )}
              </StepCard>
              <StepCard
                n={3}
                top={L.gwStep3.top}
                h={L.gwStep3.h}
                title="在客户端里接入 llama-web"
                hint="客户端只需要配置这一次，以后换服务、换 key 都在 llama-web 里改。"
                done={gw.done[2]}
                current={currentGw === 3}
              >
                <div style={{display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 6, fontSize: 13}}>
                  <span style={{color: COLORS.textFaint}}>Base URL</span>
                  <span style={{fontFamily: FONT.mono}}>http://192.168.1.10:5001/v1</span>
                  <span style={{color: COLORS.textFaint}}>model</span>
                  <span style={{fontFamily: FONT.mono}}>Strata-qwen3-32b</span>
                  <span style={{color: COLORS.textFaint}}>API key</span>
                  <span>局域网不校验，随便填一个即可</span>
                </div>
              </StepCard>
            </>
          )}
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            top: (mode === 'local' ? L.step4.top + L.step4.h : L.gwStep3.top + L.gwStep3.h) + 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Btn variant={anyProgress ? 'primary' : 'outline'} icon={anyProgress ? Play : undefined} label={anyProgress ? '完成，去总览' : '先跳过'} />
          <span style={{fontSize: 12, color: COLORS.textFaint}}>
            完成后左侧的「新手引导」会消失，之后在「模型」「接入」「设置」页里继续配置。
          </span>
        </div>
      </div>
    </div>
  );
};
