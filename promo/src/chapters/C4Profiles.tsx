import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {ModelEditorDrawer} from '../pages/ModelEditorDrawer';
import {ModelsPage} from '../pages/ModelsPage';
import {EventItem, OverviewModelStatus, OverviewPage} from '../pages/OverviewPage';
import {cue, STORY} from '../story';
import {COLORS, FONT} from '../theme';
import {AppShell, Serving} from '../ui/AppShell';
import {Camera, mixShot, Shot} from '../ui/Camera';
import {Chip} from '../ui/lw';

// Chapter 4 — Profiles & Automatic Switching
// Frame-driven animation with beats pinned to narration cues.

const C = STORY.c4Profiles;

const c4_1 = cue('c4Profiles', 'c4-1');
const c4_2 = cue('c4Profiles', 'c4-2');
const c4_3 = cue('c4Profiles', 'c4-3');
const c4_4 = cue('c4Profiles', 'c4-4');

// Camera shots
const SHOTS: readonly {at: number; v: Shot}[] = [
  // c4-1: Focus cleanly on drawer with scheme cards + left area for request bubble
  {at: 0, v: {zoom: 1.18, x: 920, y: 345}},

  // c4-2: Full frame of Overview: left sidebar ("正在服务" loading) + OverviewHero progress bar
  {at: c4_2 - 6, v: {zoom: 1.0, x: 720, y: 405}},

  // c4-3: Full frame: request bubble, "请求" queue stat, and recent events
  {at: c4_3 - 6, v: {zoom: 1.0, x: 720, y: 405}},

  // c4-4: Camera pushes tightly and cleanly into generation speed (big number + curve)
  {at: c4_4 - 6, v: {zoom: 1.55, x: 1080, y: 220}},
];

// Floating request bubble (using real llama-web style building blocks)
const RequestBubble: React.FC<{
  modelText: string;
  enter: number;
  x: number;
  y: number;
}> = ({modelText, enter, x, y}) => {
  if (enter <= 0.001) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        zIndex: 60,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 16}px) scale(${0.96 + 0.04 * enter})`,
        background: COLORS.surface,
        border: `1px solid ${COLORS.borderStrong}`,
        borderRadius: 12,
        padding: '12px 16px',
        boxShadow: '0 16px 36px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 260,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
        <Chip accent mono style={{height: 20, fontSize: 11}}>POST /v1/chat/completions</Chip>
        <span style={{fontSize: 11, color: COLORS.textFaint}}>客户端请求</span>
      </div>
      <div
        style={{
          background: COLORS.surfaceInset,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          padding: '8px 12px',
          fontFamily: FONT.mono,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <span style={{color: COLORS.textMuted}}>model: </span>
        <span style={{color: COLORS.ok, fontWeight: 500}}>"{modelText}"</span>
      </div>
    </div>
  );
};

export const ProfilesChapter: React.FC = () => {
  const frame = useCurrentFrame();

  // Manual shot interpolation with easing
  let currentShot = SHOTS[0].v;
  for (let i = 0; i < SHOTS.length - 1; i++) {
    const s0 = SHOTS[i];
    const s1 = SHOTS[i + 1];
    if (frame >= s0.at && frame < s1.at) {
      currentShot = s0.v;
      break;
    } else if (frame >= s1.at) {
      if (i + 1 === SHOTS.length - 1 || frame < SHOTS[i + 2].at) {
        const transFrames = 14;
        const progress = Math.min(1, Math.max(0, (frame - s1.at) / transFrames));
        // smooth ease
        const eased = progress * progress * (3 - 2 * progress);
        currentShot = mixShot(s0.v, s1.v, eased);
      }
    }
  }

  // --- c4-1: Scheme cards staggered entrance + Request bubble 1 ---
  const card1Enter = ramp(frame, c4_1 + 4, c4_1 + 14);
  const card2Enter = ramp(frame, c4_1 + 14, c4_1 + 24);
  const card3Enter = ramp(frame, c4_1 + 24, c4_1 + 34);

  // Request bubble 1 floats in when narration introduces scheme naming
  const bubble1Enter =
    frame < c4_1 + 28
      ? 0
      : frame < c4_1 + 38
        ? ramp(frame, c4_1 + 28, c4_1 + 38)
        : frame >= c4_2
          ? ramp(frame, c4_2, c4_2 + 6, [1, 0])
          : 1;

  // --- c4-2: Switch to OverviewPage, loading progress bar reaches 100%, becomes ready ---
  const isOverview = frame >= c4_2;

  // Pulse for loading dot
  const pulse = (Math.sin((frame * Math.PI) / 10) + 1) / 2;

  // Progress for Qwen3-8B loading in c4-2
  const qwenLoadingProgress = Math.round(
    interpolate(frame, [c4_2, c4_2 + 32], [28, 100], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );

  const qwenIsReady = frame >= c4_2 + 35;

  // --- c4-3: Request bubble 2, Queue switch to 1, Recent events, then Gemma loading ---
  const bubble2Enter =
    frame < c4_3 + 6
      ? 0
      : frame < c4_3 + 16
        ? ramp(frame, c4_3 + 6, c4_3 + 16)
        : frame >= c4_4
          ? ramp(frame, c4_4, c4_4 + 6, [1, 0])
          : 1;

  // Queued switch state
  const isQueued = frame >= c4_3 + 16 && frame < c4_3 + 52;
  const isGemmaLoading = frame >= c4_3 + 52 && frame < c4_4;

  const gemmaProgress = Math.round(
    interpolate(frame, [c4_3 + 52, c4_4], [18, 92], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );

  // Recent events in c4-3 and c4-4
  const hasQwenStoppedEvent = frame >= c4_3 + 36;
  const hasGemmaLoadingEvent = frame >= c4_3 + 54;

  const events: EventItem[] = [];
  if (hasGemmaLoadingEvent) {
    events.push({
      id: 'e-gemma-load',
      dot: 'warn',
      text: 'Gemma-3-12B（默认）：已停止 → 加载中',
      time: '18:05:03',
    });
  }
  if (hasQwenStoppedEvent) {
    events.push({
      id: 'e-qwen-stop',
      dot: 'dim',
      text: 'Qwen3-8B（长上下文）：运行中 → 已停止',
      time: '18:05:01',
    });
  }
  events.push({
    id: 'e-init',
    dot: 'ok',
    text: 'Qwen3-8B（长上下文）：加载中 → 运行中',
    time: '18:04:12',
  });
  events.push({
    id: 'e-prev',
    dot: 'dim',
    text: 'Qwen3-8B（长上下文）：已停止 → 加载中',
    time: '18:03:55',
  });

  // --- c4-4: Speed curve draws from left to right, number jumps to 42.7 ---
  const curveProgress = ramp(frame, c4_4 + 10, c4_4 + 52);
  const showSpeedNumber = frame >= c4_4 + 8;

  // Construct Hero status based on current beat
  let heroStatus: OverviewModelStatus;
  let servingState: Serving;

  if (frame >= c4_4) {
    // c4-4: Generation speed tight shot (Gemma-3-12B or Qwen3-8B ready & generating at 42.7 t/s)
    heroStatus = {
      state: 'ready',
      name: 'Gemma-3-12B',
      file: 'X:\\models\\Gemma-3-12B-it-Q4_K_M.gguf',
      profile: '默认',
      ctx: 32768,
      quant: 'Q4_K_M',
      uptime: '刚刚',
      inflight: 1,
      speedTps: showSpeedNumber ? '42.7' : '–',
      promptTps: '812',
      curveProgress,
    };
    servingState = {
      state: 'ready',
      model: 'Gemma-3-12B',
      tps: showSpeedNumber ? '42.7' : '–',
      generating: true,
    };
  } else if (isGemmaLoading) {
    // c4-3 late: Gemma loading
    heroStatus = {
      state: 'loading',
      name: 'Gemma-3-12B',
      progress: gemmaProgress,
      pulse,
    };
    servingState = {
      state: 'loading',
      model: 'Gemma-3-12B',
      percent: gemmaProgress,
      pulse,
    };
  } else if (qwenIsReady) {
    // c4-2 late & c4-3 early: Qwen running
    heroStatus = {
      state: 'ready',
      name: 'Qwen3-8B',
      file: 'X:\\models\\Qwen3-8B-Q4_K_M.gguf',
      profile: '长上下文',
      ctx: 131072,
      quant: 'Q4_K_M',
      vision: true,
      uptime: '已运行 1 分钟',
      inflight: 1,
      speedTps: '–',
      curveProgress: 0,
    };
    servingState = {
      state: 'ready',
      model: 'Qwen3-8B',
      tps: '–',
      generating: false,
    };
  } else {
    // c4-2 early: Qwen loading
    heroStatus = {
      state: 'loading',
      name: 'Qwen3-8B',
      progress: qwenLoadingProgress,
      pulse,
    };
    servingState = {
      state: 'loading',
      model: 'Qwen3-8B',
      percent: qwenLoadingProgress,
      pulse,
    };
  }

  return (
    <AbsoluteFill>
      <Background />
      <Camera shot={currentShot}>
        <AppShell
          active={isOverview ? 'overview' : 'models'}
          counts={{models: 2}}
          serving={servingState}
          overlay={
            <>
              {/* Request Bubble 1 (c4-1) */}
              <RequestBubble
                modelText="Qwen3-8B:长上下文"
                enter={bubble1Enter}
                x={340}
                y={240}
              />

              {/* Request Bubble 2 (c4-3) */}
              <RequestBubble
                modelText="Gemma-3-12B"
                enter={bubble2Enter}
                // Over the llama.cpp / public-access cards: keeps the hero, queue count and events visible.
                x={640}
                y={295}
              />

              {/* Edit Drawer in c4-1 */}
              {!isOverview ? (
                <ModelEditorDrawer
                  open={true}
                  enter={1}
                  tab="profiles"
                  modelName="Qwen3-8B"
                  cardEnters={[card1Enter, card2Enter, card3Enter]}
                />
              ) : null}
            </>
          }
        >
          {isOverview ? (
            <OverviewPage
              hero={heroStatus}
              requests={{
                inflight: isQueued ? 1 : heroStatus.state === 'ready' ? 1 : 0,
                queued: isQueued ? 1 : 0,
                queuedModels: isQueued ? '等待加载：Gemma-3-12B' : '',
              }}
              recentEvents={events}
            />
          ) : (
            <ModelsPage tab="enabled" qwenEnabled />
          )}
        </AppShell>
      </Camera>

      <Voice chapter="c4Profiles" />
      <Captions lines={C.captions} end={C.durationInFrames} />
    </AbsoluteFill>
  );
};
