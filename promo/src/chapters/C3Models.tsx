import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Cursor} from '../components/Controls';
import {Typewriter} from '../components/Typewriter';
import {Voice} from '../components/Voice';
import {ramp, typedCount} from '../lib/anim';
import {mixPt, pressAt, rippleAt, track} from '../lib/track';
import {FirstStartDialog, FIRST_START_LAYOUT} from '../pages/FirstStartDialog';
import {ModelEditorDrawer, MODEL_EDITOR_LAYOUT} from '../pages/ModelEditorDrawer';
import {ModelsPage, MODELS_LAYOUT} from '../pages/ModelsPage';
import {cue, STORY} from '../story';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, project, Shot} from '../ui/Camera';
import {Toast} from '../ui/lw';

// Chapter 3 — Models: scan, parameters, memory estimate, command preview.
// Frame-driven animation with beats pinned to narration cues.

const C = STORY.c3Models;

const c3_1 = cue('c3Models', 'c3-1');
const c3_2 = cue('c3Models', 'c3-2');
const c3_3 = cue('c3Models', 'c3-3');
const c3_4 = cue('c3Models', 'c3-4');
const c3_5 = cue('c3Models', 'c3-5');

// Beats
const B = {
  // c3-1: 扫描发现网格，点「启用」
  enable: c3_1 + 75, // click 启用

  // c3-2: 已启用列表点「启动」→ 首次启动弹窗 → 点「确认并启动」
  start: c3_2 + 32, // click 启动
  confirm: c3_2 + 105, // click 确认并启动

  // c3-3: 打开编辑抽屉「参数」，上下文从「继承」切到「自定义」
  modeSwitch: c3_3 + 55, // click 继承 -> 自定义

  // c3-4: 数值 32768 -> 131072 (有风险 -> 放不下)，再改回 65536 (放得下)
  ctxFocus: c3_4 + 18,
  ctxStepRisk: c3_4 + 32,
  ctxStepNofit: c3_4 + 50,
  ctxReset: c3_4 + 105,

  // c3-5: 额外参数打字 --jinja，命令预览同步出现
  extraFocus: c3_5 + 24,
  typeExtra: c3_5 + 30,
} as const;

const CLICKS = [
  B.enable,
  B.start,
  B.confirm,
  B.modeSwitch,
  B.ctxFocus,
  B.ctxReset,
  B.extraFocus,
] as const;

const SHOTS: readonly {at: number; v: Shot}[] = [
  // c3-1: Framed nicely on Discover cards
  {at: 0, v: {zoom: 1.12, x: 680, y: 350}},
  {at: B.enable - 20, v: {zoom: 1.2, x: 740, y: 360}},

  // c3-2: Switch to enabled row, then center on modal higher up to avoid subtitles
  {at: c3_2 - 10, v: {zoom: 1.15, x: 920, y: 240}},
  {at: B.start + 10, v: {zoom: 1.18, x: 720, y: 345}},

  // c3-3: Drawer opens on the right, focus on parameters
  {at: c3_3 - 10, v: {zoom: 1.38, x: 1160, y: 310}},

  // c3-4: Tight focus on context input + memory estimate bar
  {at: c3_4 - 10, v: {zoom: 1.42, x: 1160, y: 320}},

  // c3-5: Pan down slightly to reveal extra args + command preview
  {at: c3_5 - 15, v: {zoom: 1.38, x: 1160, y: 550}},
];

// Cursor path in native app coordinates
const CURSOR = [
  {at: 0, v: {x: 950, y: 550}},
  {at: B.enable - 20, v: MODELS_LAYOUT.enableBtn},
  {at: c3_2 + 10, v: {x: 1200, y: 250}},
  {at: B.start - 15, v: MODELS_LAYOUT.startBtn},
  {at: B.confirm - 25, v: FIRST_START_LAYOUT.confirmBtn},
  {at: c3_3 + 20, v: {x: 1200, y: 250}},
  {at: B.modeSwitch - 18, v: MODEL_EDITOR_LAYOUT.contextModeSelect},
  {at: B.ctxFocus - 15, v: MODEL_EDITOR_LAYOUT.contextInput},
  {at: B.ctxReset - 15, v: MODEL_EDITOR_LAYOUT.contextInput},
  {at: B.extraFocus - 18, v: MODEL_EDITOR_LAYOUT.extraArgsInput},
  {at: B.extraFocus + 45, v: {x: MODEL_EDITOR_LAYOUT.extraArgsInput.x + 35, y: MODEL_EDITOR_LAYOUT.extraArgsInput.y}},
] as const;

export const ModelsChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');
  const cursorApp = track(frame, fps, CURSOR, mixPt, 'snappy');
  const cursor = project(shot, cursorApp);
  const press = (at: number) => (frame >= at && frame < at + 8 ? pressAt(frame, [at]) : 0);

  // Toast animation (enters after enable click in c3-1, dismisses when switching to enabled in c3-2)
  const toastEnter =
    frame < B.enable
      ? 0
      : frame < B.enable + 10
        ? ramp(frame, B.enable, B.enable + 10)
        : frame >= c3_2
          ? ramp(frame, c3_2, c3_2 + 8, [1, 0])
          : 1;

  // Dialog in c3-2
  const dialogEnter =
    frame < B.start
      ? 0
      : frame < B.start + 8
        ? ramp(frame, B.start, B.start + 8)
        : frame >= B.confirm
          ? ramp(frame, B.confirm, B.confirm + 6, [1, 0])
          : 1;
  const dialogOpen = frame >= B.start && dialogEnter > 0.01;

  // Drawer in c3-3 .. c3-5
  const drawerEnter =
    frame < c3_3
      ? 0
      : frame < c3_3 + 10
        ? ramp(frame, c3_3, c3_3 + 10)
        : 1;
  const drawerOpen = frame >= c3_3;

  // Context value and memory estimate tier in c3-4
  const ctxVal =
    frame < B.ctxStepRisk
      ? 32768
      : frame < B.ctxStepNofit
        ? 98304
        : frame < B.ctxReset
          ? 131072
          : 65536;

  const tier: 'fit' | 'risk' | 'nofit' =
    ctxVal >= 131072 ? 'nofit' : ctxVal > 65536 ? 'risk' : 'fit';

  // Extra args typing in c3-5
  const extraText = '--jinja';
  const extraTypedCount = typedCount(frame, B.typeExtra, extraText.length, 3);
  const extraArgsString = frame >= B.typeExtra ? extraText.slice(0, extraTypedCount) : '';
  const extraArgsNode =
    frame >= B.typeExtra ? (
      <Typewriter text={extraText} start={B.typeExtra} framesPerChar={3} caretHold={60} />
    ) : null;

  return (
    <AbsoluteFill>
      <Background />
      <Camera shot={shot}>
        <AppShell
          active="models"
          counts={{models: frame >= B.enable ? 2 : 1}}
          overlay={
            <>
              {toastEnter > 0.01 ? (
                <Toast
                  title="已启用「Qwen3-8B」，到「已启用」里点启动。"
                  enter={toastEnter}
                  style={{top: 410, left: 450, right: 'auto', bottom: 'auto'}}
                />
              ) : null}

              <FirstStartDialog
                open={dialogOpen}
                enter={dialogEnter}
                modelName="Qwen3-8B"
                confirmPressed={press(B.confirm)}
              />

              <ModelEditorDrawer
                open={drawerOpen}
                enter={drawerEnter}
                modelName="Qwen3-8B"
                contextMode={frame >= B.modeSwitch ? 'custom' : 'inherit'}
                contextValue={ctxVal}
                tier={tier}
                extraArgs={extraArgsNode}
                extraArgsString={extraArgsString}
                modeSelectPressed={press(B.modeSwitch)}
                contextInputPressed={press(B.ctxFocus) || press(B.ctxReset)}
                extraArgsPressed={press(B.extraFocus)}
              />
            </>
          }
        >
          <ModelsPage
            tab={frame >= c3_2 ? 'enabled' : 'discover'}
            qwenEnabled={frame >= B.enable}
            qwenState={frame >= B.confirm ? 'ready' : 'stopped'}
            enablePressed={press(B.enable)}
            startPressed={press(B.start)}
          />
        </AppShell>
      </Camera>

      <Cursor
        x={cursor.x}
        y={cursor.y}
        press={rippleAt(frame, CLICKS)}
        opacity={ramp(frame, c3_1 + 10, c3_1 + 25)}
      />

      <Voice chapter="c3Models" />
      <Captions lines={C.captions} end={C.durationInFrames} />
    </AbsoluteFill>
  );
};
