import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Cursor} from '../components/Controls';
import {Typewriter} from '../components/Typewriter';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {mixPt, pressAt, rippleAt, track} from '../lib/track';
import {SetupPage, SETUP_LAYOUT as L} from '../pages/SetupPage';
import {cue, STORY} from '../story';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, project, Shot} from '../ui/Camera';

// Chapter 2 — the first-run guide (新手引导), local path then a glimpse of the gateway path.
// Reference implementation for all app chapters: page state is a pure function of the frame,
// the camera and cursor follow keyframe tracks, clicks are listed once and reused for press + ripple.

const C = STORY.c2Setup;

const c2_2 = cue('c2Setup', 'c2-2');
const c2_3 = cue('c2Setup', 'c2-3');
const c2_4 = cue('c2Setup', 'c2-4');
const c2_5 = cue('c2Setup', 'c2-5');

// Beats (relative to narration cues).
const B = {
  // 选目录这组节拍从 cue('c2Setup','c2-2') 开始
  focusInput: c2_2, // click into the path input
  typePath: c2_2 + 4,
  addScan: c2_2 + 34, // click 添加并扫描
  scanned: c2_2 + 44, // directory added, 4 files found, step 1 ticks

  // 下载这组从 c2-3 开始
  download: c2_3 + 4, // click 下载并安装
  query: c2_3 + 8, // 正在查询最新版本
  downloadFrom: c2_3 + 24, // 正在下载 n%
  downloadTo: c2_3 + 90,
  unpack: c2_3 + 92, // 正在解压
  installed: c2_3 + 116, // 已安装：b11146 (download -> installed = 112 frames >= 100)

  // 「去启用模型」点击在 c2-4 内
  enableClick: c2_4 + 24, // click 去启用模型

  // 切到「只接入外部 API」从 c2-5 开始
  gatewayClick: c2_5 + 18, // click the 只接入外部 API mode card
  gwStep1: c2_5 + 54,
  gwStep2: c2_5 + 80,
} as const;

const PATH = 'X:\\models';

const SHOTS: readonly {at: number; v: Shot}[] = [
  {at: 0, v: {zoom: 0.84, x: 720, y: 405}},
  {at: 4, v: {zoom: 1, x: 720, y: 405}},
  {at: B.focusInput - 18, v: {zoom: 1.7, x: 840, y: 320}},
  {at: B.download - 18, v: {zoom: 1.7, x: 840, y: 530}},
  {at: B.enableClick - 30, v: {zoom: 1.6, x: 840, y: 640}},
  {at: B.gatewayClick - 36, v: {zoom: 1, x: 720, y: 405}},
  {at: B.gwStep2 + 12, v: {zoom: 1.45, x: 840, y: 520}},
];

const CLICKS = [B.focusInput, B.addScan, B.download, B.enableClick, B.gatewayClick] as const;

// Cursor path in native app coordinates.
const input = {x: L.x + 400, y: L.addAndScan.y};
const CURSOR = [
  {at: 0, v: {x: 1160, y: 760}},
  {at: B.focusInput - 16, v: input},
  {at: B.addScan - 16, v: L.addAndScan},
  {at: B.download - 16, v: L.downloadBtn},
  {at: B.enableClick - 20, v: L.enableBtn},
  {at: B.gatewayClick - 30, v: L.modeGateway},
  {at: B.gatewayClick + 16, v: {x: 1250, y: 700}},
] as const;

export const SetupChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');
  const cursorApp = track(frame, fps, CURSOR, mixPt, 'snappy');
  const cursor = project(shot, cursorApp);
  const press = (at: number) => (frame >= at && frame < at + 8 ? pressAt(frame, [at]) : 0);

  const downloadPct = Math.round(ramp(frame, B.downloadFrom, B.downloadTo) * 100);
  const runtimeLine =
    frame < B.downloadFrom ? '正在查询最新版本' : frame < B.unpack ? `正在下载 b11146（${downloadPct}%）` : '正在解压 b11146';

  const mode = frame >= B.gatewayClick + 4 ? 'gateway' : 'local';
  const stepsOpacity =
    frame < B.gatewayClick
      ? 1
      : Math.max(
          ramp(frame, B.gatewayClick, B.gatewayClick + 4, [1, 0]),
          ramp(frame, B.gatewayClick + 4, B.gatewayClick + 12)
        );

  return (
    <AbsoluteFill>
      <Background />
      <Camera shot={shot}>
        <AppShell
          active="guide"
          showGuide
          llamacpp={{tag: frame >= B.installed ? 'b11146' : null}}
          counts={{models: 0}}
        >
          <SetupPage
            mode={mode}
            stepsOpacity={stepsOpacity}
            local={{
              dir: {
                added: frame >= B.scanned ? PATH : null,
                typed:
                  frame >= B.typePath && frame < B.scanned ? (
                    <Typewriter text={PATH} start={B.typePath} framesPerChar={2} caretHold={40} />
                  ) : null,
                focused: frame >= B.focusInput && frame < B.scanned,
                found: frame >= B.scanned ? 4 : null,
                addPressed: press(B.addScan),
              },
              runtime: {
                status: frame < B.download ? 'none' : frame < B.installed ? 'busy' : 'done',
                line: runtimeLine,
                tag: 'b11146',
                pressed: press(B.download),
              },
              enable: {done: null, pressed: press(B.enableClick)},
            }}
            gateway={{
              done: [frame >= B.gwStep1, frame >= B.gwStep2, false],
              services: 'Strata',
              models: 3,
            }}
          />
        </AppShell>
      </Camera>
      <Cursor
        x={cursor.x}
        y={cursor.y}
        press={rippleAt(frame, CLICKS)}
        opacity={ramp(frame, B.focusInput - 22, B.focusInput - 14) * ramp(frame, B.gatewayClick + 44, B.gatewayClick + 56, [1, 0])}
      />
      <Voice chapter="c2Setup" />
      <Captions lines={C.captions} end={C.durationInFrames} />
    </AbsoluteFill>
  );
};
