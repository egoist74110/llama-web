import React from 'react';
import {AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {RequestPipeline} from '../components/RequestPipeline';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {LogsPage, RequestRowItem} from '../pages/LogsPage';
import {cue, STORY} from '../story';
import {COLORS, FONT, SPRING} from '../theme';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, Shot} from '../ui/Camera';
import {track} from '../lib/track';

// Chapter 7: What a request goes through (一条请求经过什么)
// Narration cues: c7-1 to c7-6 from narration.json & vo-manifest.json.

const C = STORY.c7Request;

const c7_1 = cue('c7Request', 'c7-1');
const c7_2 = cue('c7Request', 'c7-2');
const c7_3 = cue('c7Request', 'c7-3');
const c7_4 = cue('c7Request', 'c7-4');
const c7_5 = cue('c7Request', 'c7-5');
const c7_6 = cue('c7Request', 'c7-6');

// Timeline beats
const B = {
  // c7-1: Pipeline intro, packet leaves client
  packetDepart: c7_1 + 4,
  packetAtHub: c7_1 + 38,

  // c7-2: Compress station -> key station -> Strata -> stream back
  compressEnter: c7_2 + 4,
  compressPass: c7_2 + 16,
  keyEnter: c7_2 + 28,
  keyPass: c7_2 + 42,
  strataArrive: c7_2 + 54,
  streamDepart: c7_2 + 64,
  streamTypeStart: c7_2 + 68,
  streamTypeEnd: c7_3 - 8,

  // c7-3: Cut to LogsPage, Strata row enters with highlight, camera pushes in
  cutToLogs: c7_3 - 2,
  strataRowEnter: c7_3 + 2,
  strataRowSettled: c7_3 + 14,

  // c7-4: Four new rows enter successively with highlight, followed by alpaca card pop-up
  ttsRowEnter: c7_4 + 6,
  ttsRowSettled: c7_4 + 18,
  mossRowEnter: c7_4 + 32,
  mossRowSettled: c7_4 + 44,
  imageRowEnter: c7_4 + 58,
  imageRowSettled: c7_4 + 70,
  alpacaCardEnter: c7_4 + 68,
  imageEditRowEnter: c7_4 + 86,
  imageEditRowSettled: c7_4 + 98,
  videoT2vRowEnter: c7_4 + 112,
  videoT2vRowSettled: c7_4 + 124,
  videoI2vRowEnter: c7_4 + 136,
  videoI2vRowSettled: c7_4 + 148,

  // c7-5: Floating narration audio card appears in corner, TTS row re-highlighted
  audioCardEnter: c7_5 + 4,

  // c7-6: Subtitle appended to audio card, MOSS row highlighted strongly again
  mossHighlightRevisit: c7_6,
} as const;

// Camera shots for LogsPage portion
const SHOTS: readonly {at: number; v: Shot}[] = [
  // Full view before c7-3
  {at: 0, v: {zoom: 1.0, x: 720, y: 405}},

  // c7-3: Camera pushes firmly towards Strata row and the "不包含对话内容" note
  {at: c7_3, v: {zoom: 1.30, x: 620, y: 330}},

  // c7-4: Camera reframes comfortably around the new rows and alpaca card
  {at: c7_4, v: {zoom: 1.20, x: 640, y: 360}},
  {at: c7_4 + 50, v: {zoom: 1.10, x: 670, y: 422}},

  // c7-5: Camera reframes to clearly frame TTS row and narration card
  {at: c7_5, v: {zoom: 1.15, x: 660, y: 504}},

  // c7-6: Camera frames both MOSS row and the expanded narration card
  {at: c7_6, v: {zoom: 1.15, x: 660, y: 504}},
];

// Earlier request background rows
const BACKGROUND_ROWS: readonly RequestRowItem[] = [
  {
    id: 'r3',
    time: '18:03:10',
    source: 'local',
    model: 'Qwen3-8B',
    profile: '默认',
    status: '200 成功',
    duration: '1.45 s',
    tokens: '420 → 188',
    images: '—',
    params: 'temperature=0.7',
  },
  {
    id: 'r4',
    time: '18:00:22',
    source: 'lan',
    model: 'Qwen3-8B',
    profile: '长上下文',
    status: '200 成功',
    duration: '3.10 s',
    tokens: '2840 → 412',
    images: '—',
    params: 'temperature=0.7 max_tokens=2048',
  },
  {
    id: 'r5',
    time: '17:58:05',
    source: 'public',
    model: 'Qwen3-8B',
    profile: '默认',
    status: '200 成功',
    duration: '1.82 s',
    tokens: '890 → 215',
    images: '—',
    params: 'temperature=0.8',
  },
];

// Large narration highlight card in c7-5 & c7-6
const AudioNarrationCard: React.FC<{
  frame: number;
  fps: number;
}> = ({frame, fps}) => {
  if (frame < B.audioCardEnter) return null;

  // Spring scale pop + fade in entrance
  const spr = spring({
    frame: frame - B.audioCardEnter,
    fps,
    config: SPRING.pop,
  });
  const opacity = ramp(frame, B.audioCardEnter, B.audioCardEnter + 8);

  // 7 undulating wave bars driven strictly by Math.sin (deterministic, no random)
  const waveBars = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const wave = Math.sin((frame - c7_5) * 0.22 + i * 0.95);
    const h = 10 + 24 * Math.abs(wave);
    return (
      <div
        key={i}
        style={{
          width: 4.5,
          height: h,
          borderRadius: 2.5,
          background: COLORS.accent,
          margin: '0 2px',
        }}
      />
    );
  });

  const showSub = frame >= c7_6;
  const subOpacity = showSub ? ramp(frame, c7_6, c7_6 + 10) : 0;
  const subSlide = showSub ? (1 - ramp(frame, c7_6, c7_6 + 10)) * 6 : 0;

  return (
    <div
      style={{
        position: 'absolute',
        left: 360,
        top: 552,
        width: 660,
        zIndex: 500,
        opacity,
        transform: `scale(${spr})`,
        transformOrigin: 'center center',
        background: COLORS.surfaceRaised,
        border: `1.5px solid ${COLORS.accent}`,
        borderRadius: 16,
        padding: '20px 26px',
        boxSizing: 'border-box',
        boxShadow: `0 24px 60px rgba(0, 0, 0, 0.65), 0 0 32px ${COLORS.accentSoft}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        pointerEvents: 'none',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 20}}>
        {/* Enlarged animated wave box */}
        <div
          style={{
            width: 58,
            height: 58,
            borderRadius: 14,
            background: COLORS.accentSoft,
            border: `1px solid ${COLORS.accentLine}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', height: 38}}>
            {waveBars}
          </div>
        </div>

        <div style={{minWidth: 0, flex: 1}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <span style={{fontSize: 12.5, color: COLORS.accentText, fontWeight: 600}}>本片旁白</span>
            <span
              style={{
                fontSize: 11,
                color: COLORS.ok,
                background: 'rgba(74, 222, 128, 0.14)',
                border: '1px solid rgba(74, 222, 128, 0.35)',
                padding: '2px 7px',
                borderRadius: 5,
                fontWeight: 600,
              }}
            >
              已验证
            </span>
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.text,
              marginTop: 4,
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
          >
            另一台机器上的 TTS → llama-web 转发
          </div>
          <div
            style={{
              fontSize: 13,
              fontFamily: FONT.mono,
              color: COLORS.textFaint,
              marginTop: 5,
            }}
          >
            /v1/audio/speech · 诗歌剧_ZH
          </div>
        </div>
      </div>

      {showSub ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: 10,
            opacity: subOpacity,
            transform: `translateY(${subSlide}px)`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: COLORS.accentText,
              background: COLORS.accentSoft,
              border: `1px solid ${COLORS.accentLine}`,
              padding: '2px 7px',
              borderRadius: 5,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            语音识别
          </span>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              color: COLORS.text,
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            旁白念得准不准：经 llama-web 转发的语音识别逐句检查
          </div>
        </div>
      ) : null}
    </div>
  );
};

// Floating alpaca image comparison card in c7-4 (side-by-side, max-width ~480 native px)
const AlpacaCard: React.FC<{
  frame: number;
  fps: number;
}> = ({frame, fps}) => {
  if (frame < B.alpacaCardEnter || frame >= c7_5 + 8) return null;

  const spr = spring({
    frame: frame - B.alpacaCardEnter,
    fps,
    config: SPRING.pop,
  });
  const opacity =
    frame >= c7_5
      ? ramp(frame, c7_5, c7_5 + 8, [1, 0])
      : ramp(frame, B.alpacaCardEnter, B.alpacaCardEnter + 8);

  const showEdit = frame >= B.imageEditRowEnter;
  const editOpacity = showEdit
    ? ramp(frame, B.imageEditRowEnter, B.imageEditRowEnter + 10)
    : 0;
  const editSpr = showEdit
    ? spring({
        frame: frame - B.imageEditRowEnter,
        fps,
        config: SPRING.snappy,
      })
    : 0;

  // Crossfade between images and videos
  const videoSwitch = ramp(frame, B.videoT2vRowEnter, B.videoT2vRowEnter + 10);

  return (
    <div
      style={{
        position: 'absolute',
        left: 660,
        top: 466,
        width: 456,
        zIndex: 500,
        opacity,
        transform: `scale(${spr})`,
        transformOrigin: 'center center',
        background: COLORS.surfaceRaised,
        border: `1px solid ${COLORS.borderStrong}`,
        borderRadius: 14,
        boxShadow: `0 20px 48px rgba(0, 0, 0, 0.55), 0 0 24px rgba(79, 91, 213, 0.2)`,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          background: COLORS.surfaceInset,
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 99,
            background: COLORS.ok,
            boxShadow: `0 0 6px ${COLORS.ok}`,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.accentText,
            letterSpacing: '0.01em',
          }}
        >
          经 llama-web 转发生成
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          padding: '8px 10px 10px',
          background: COLORS.surfaceRaised,
        }}
      >
        {/* Images view */}
        {videoSwitch < 1 ? (
          <div
            style={{
              display: 'flex',
              gap: 10,
              opacity: 1 - videoSwitch,
            }}
          >
            {/* Left: Original generation */}
            <div style={{flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5}}>
              <div
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: COLORS.surfaceInset,
                  border: `1px solid ${COLORS.border}`,
                  height: 116,
                }}
              >
                <Img
                  src={staticFile('proof/alpaca.png')}
                  style={{
                    width: '100%',
                    height: 116,
                    objectFit: 'cover',
                    objectPosition: 'center 18%',
                    display: 'block',
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: COLORS.textMuted,
                  textAlign: 'center',
                }}
              >
                生图
              </div>
            </div>

            {/* Right: Edited image */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <div
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: COLORS.surfaceInset,
                  border: showEdit
                    ? `1px solid ${COLORS.accentLine}`
                    : `1px dashed rgba(255, 255, 255, 0.12)`,
                  height: 116,
                  position: 'relative',
                }}
              >
                {showEdit ? (
                  <Img
                    src={staticFile('proof/alpaca-edit.png')}
                    style={{
                      width: '100%',
                      height: 116,
                      objectFit: 'cover',
                      objectPosition: 'center 18%',
                      display: 'block',
                      opacity: editOpacity,
                      transform: `scale(${0.96 + 0.04 * editSpr})`,
                      transformOrigin: 'center center',
                    }}
                  />
                ) : null}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: COLORS.accentText,
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  opacity: editOpacity,
                  transform: showEdit ? `scale(${0.96 + 0.04 * editSpr})` : 'scale(0.96)',
                }}
              >
                改图：耳机换成红色
              </div>
            </div>
          </div>
        ) : null}

        {/* Videos view */}
        {videoSwitch > 0 ? (
          <div
            style={{
              position: videoSwitch < 1 ? 'absolute' : 'relative',
              top: videoSwitch < 1 ? 8 : undefined,
              left: videoSwitch < 1 ? 10 : undefined,
              right: videoSwitch < 1 ? 10 : undefined,
              bottom: videoSwitch < 1 ? 10 : undefined,
              display: 'flex',
              gap: 10,
              opacity: videoSwitch,
            }}
          >
            {/* Left: Text-to-video */}
            <div style={{flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5}}>
              <div
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: COLORS.surfaceInset,
                  border: `1px solid ${COLORS.border}`,
                  height: 116,
                }}
              >
                <Img
                  src={staticFile('proof/video-t2v.jpg')}
                  style={{
                    width: '100%',
                    height: 116,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: COLORS.accentText,
                  textAlign: 'center',
                }}
              >
                文生视频
              </div>
            </div>

            {/* Right: Image-to-video */}
            <div style={{flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5}}>
              <div
                style={{
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: COLORS.surfaceInset,
                  border: `1px solid ${COLORS.border}`,
                  height: 116,
                }}
              >
                <Img
                  src={staticFile('proof/video-i2v.jpg')}
                  style={{
                    width: '100%',
                    height: 116,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: COLORS.accentText,
                  textAlign: 'center',
                }}
              >
                图生视频
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const RequestChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Mode: c7-1 & c7-2 show RequestPipeline; c7-3+ show LogsPage
  const showPipeline = frame < B.cutToLogs;

  // -----------------------------------------------------------------
  // RequestPipeline Animation Drivers (c7-1 & c7-2)
  // -----------------------------------------------------------------
  let packetT = 0;
  let packetVisible = false;

  if (frame >= B.packetDepart && frame < B.strataArrive) {
    packetVisible = true;
    if (frame < B.compressEnter) {
      packetT = 0.24 * ramp(frame, B.packetDepart, B.packetAtHub);
    } else if (frame < B.keyEnter) {
      packetT = 0.24 + 0.25 * ramp(frame, B.compressEnter, B.compressPass);
    } else if (frame < B.strataArrive) {
      packetT = 0.49 + 0.25 * ramp(frame, B.keyEnter, B.keyPass) + 0.26 * ramp(frame, B.keyPass, B.strataArrive);
    }
  }

  const compressHighlight =
    frame >= B.compressPass - 4 && frame < B.keyPass
      ? 1
      : frame >= B.keyPass
        ? 0.35
        : 0;

  const showCompressBadge = frame >= B.compressPass;

  const keyHighlight =
    frame >= B.keyPass - 4 && frame < B.strataArrive + 6
      ? 1
      : frame >= B.strataArrive + 6
        ? 0.35
        : 0;

  const showKeyBadge = frame >= B.keyPass;

  const upstreamHighlight =
    frame >= B.strataArrive && frame < B.streamDepart + 12
      ? 1
      : frame >= B.streamDepart + 12
        ? 0.35
        : 0;

  // Reverse packet (Strata -> Client)
  const packetBackVisible = frame >= B.streamDepart && frame < B.streamTypeEnd;
  const packetBackT = ramp(frame, B.streamDepart, B.streamDepart + 24);

  // Typewriter stream text under Client
  const showStreamCard = frame >= B.streamTypeStart;
  const streamProgress = ramp(frame, B.streamTypeStart, B.streamTypeEnd);

  // -----------------------------------------------------------------
  // LogsPage Animation Drivers (c7-3, c7-4, c7-5, c7-6)
  // -----------------------------------------------------------------
  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');

  // Strata row state
  const hasStrataRow = frame >= B.strataRowEnter;
  const strataEnter = ramp(frame, B.strataRowEnter, B.strataRowSettled);
  const strataHighlight =
    frame >= B.strataRowEnter && frame < c7_4
      ? 1 - 0.45 * ramp(frame, B.strataRowSettled + 10, B.strataRowSettled + 40)
      : 0.15;

  // TTS row state
  const hasTtsRow = frame >= B.ttsRowEnter;
  const ttsEnter = ramp(frame, B.ttsRowEnter, B.ttsRowSettled);
  const ttsHighlight =
    frame >= c7_6
      ? 0.2
      : frame >= c7_5
        ? 1.8 // Strongly highlighted throughout c7-5 alongside the large narration card
        : frame >= B.ttsRowEnter && frame < B.mossRowEnter
          ? 1.2 - 0.4 * ramp(frame, B.ttsRowSettled + 6, B.mossRowEnter)
          : 0.2;

  // MOSS row state
  const hasMossRow = frame >= B.mossRowEnter;
  const mossEnter = ramp(frame, B.mossRowEnter, B.mossRowSettled);
  const mossHighlight =
    frame >= c7_6
      ? 1.8 // Re-highlighted strongly in c7-6 alongside the subtitle
      : frame >= B.mossRowEnter && frame < B.imageRowEnter
        ? 1.2 - 0.4 * ramp(frame, B.mossRowSettled + 6, B.imageRowEnter)
        : 0.15;

  // QwenImage row state
  const hasImageRow = frame >= B.imageRowEnter;
  const imageEnter = ramp(frame, B.imageRowEnter, B.imageRowSettled);
  const imageHighlight =
    frame >= B.imageRowEnter && frame < B.imageEditRowEnter
      ? 1.2 - 0.4 * ramp(frame, B.imageRowSettled + 6, B.imageEditRowEnter)
      : 0.15;

  // QwenImage Edit row state
  const hasImageEditRow = frame >= B.imageEditRowEnter;
  const imageEditEnter = ramp(frame, B.imageEditRowEnter, B.imageEditRowSettled);
  const imageEditHighlight =
    frame >= B.imageEditRowEnter && frame < B.videoT2vRowEnter
      ? 1.2 - 0.4 * ramp(frame, B.imageEditRowSettled + 6, B.videoT2vRowEnter)
      : 0.15;

  // Comfy video T2V row state
  const hasVideoT2vRow = frame >= B.videoT2vRowEnter;
  const videoT2vEnter = ramp(frame, B.videoT2vRowEnter, B.videoT2vRowSettled);
  const videoT2vHighlight =
    frame >= B.videoT2vRowEnter && frame < B.videoI2vRowEnter
      ? 1.2 - 0.4 * ramp(frame, B.videoT2vRowSettled + 6, B.videoI2vRowEnter)
      : 0.15;

  // Comfy video I2V row state
  const hasVideoI2vRow = frame >= B.videoI2vRowEnter;
  const videoI2vEnter = ramp(frame, B.videoI2vRowEnter, B.videoI2vRowSettled);
  const videoI2vHighlight =
    frame >= B.videoI2vRowEnter && frame < c7_5
      ? 1.2 - 0.4 * ramp(frame, B.videoI2vRowSettled + 6, B.videoI2vRowSettled + 30)
      : 0.15;

  // Assemble displayed table rows
  const displayedRows: RequestRowItem[] = [];

  if (hasVideoI2vRow) {
    displayedRows.push({
      id: 'videoI2v',
      time: '18:07:20',
      source: 'lan',
      model: 'Comfy-minimax-h3-i2v',
      status: '200 成功',
      duration: '≈ 60 s',
      tokens: '—',
      images: '—',
      params: 'path=/v1/videos',
      enter: videoI2vEnter,
      highlight: videoI2vHighlight,
    });
  }

  if (hasVideoT2vRow) {
    displayedRows.push({
      id: 'videoT2v',
      time: '18:06:41',
      source: 'lan',
      model: 'Comfy-minimax-h3-t2v',
      status: '200 成功',
      duration: '≈ 60 s',
      tokens: '—',
      images: '—',
      params: 'path=/v1/videos',
      enter: videoT2vEnter,
      highlight: videoT2vHighlight,
    });
  }

  if (hasImageEditRow) {
    displayedRows.push({
      id: 'imageEdit',
      time: '18:06:06',
      source: 'lan',
      model: 'QwenImage-qwen-edit-2511',
      status: '200 成功',
      duration: '25.97 s',
      tokens: '—',
      images: '—',
      params: 'path=/v1/images/edits',
      enter: imageEditEnter,
      highlight: imageEditHighlight,
    });
  }

  if (hasImageRow) {
    displayedRows.push({
      id: 'image',
      time: '18:05:40',
      source: 'lan',
      model: 'QwenImage-qwen-image-2.1',
      status: '200 成功',
      duration: '4.82 s',
      tokens: '—',
      images: '—',
      params: 'path=/v1/images/generations size=1024x1024',
      enter: imageEnter,
      highlight: imageHighlight,
    });
  }

  if (hasMossRow) {
    displayedRows.push({
      id: 'moss',
      time: '18:05:22',
      source: 'lan',
      model: 'MOSS-OpenMOSS-Team/MOSS-Transcribe-Diarize',
      status: '200 成功',
      duration: '1.24 s',
      tokens: '—',
      images: '—',
      params: 'path=/v1/audio/transcriptions',
      enter: mossEnter,
      highlight: mossHighlight,
    });
  }

  if (hasTtsRow) {
    displayedRows.push({
      id: 'tts',
      time: '18:05:02',
      source: 'lan',
      model: 'TTS-诗歌剧_ZH',
      status: '200 成功',
      duration: '820 ms',
      tokens: '—',
      images: '—',
      params: 'path=/v1/audio/speech voice=诗歌剧_ZH',
      enter: ttsEnter,
      highlight: ttsHighlight,
    });
  }

  if (hasStrataRow) {
    displayedRows.push({
      id: 'strata',
      time: '18:04:38',
      source: 'lan',
      model: 'Strata-qwen3-32b',
      stream: true,
      status: '200 成功',
      duration: '2.31 s',
      tokens: '1234 → 567',
      images: '1 张，3.1 MB → 186 KB',
      params: 'temperature=0.7 stream=true',
      enter: strataEnter,
      highlight: strataHighlight,
    });
  }

  displayedRows.push(...BACKGROUND_ROWS);

  return (
    <AbsoluteFill style={{background: COLORS.bg}}>
      <Background />

      {showPipeline ? (
        <RequestPipeline
          packetT={packetT}
          packetVisible={packetVisible}
          compressHighlight={compressHighlight}
          showCompressBadge={showCompressBadge}
          keyHighlight={keyHighlight}
          showKeyBadge={showKeyBadge}
          upstreamHighlight={upstreamHighlight}
          packetBackT={packetBackT}
          packetBackVisible={packetBackVisible}
          streamProgress={streamProgress}
          showStreamCard={showStreamCard}
        />
      ) : (
        <Camera shot={shot}>
          <AppShell
            active="logs"
            counts={{models: 1, connections: 2}}
            overlay={
              <>
                <AlpacaCard frame={frame} fps={fps} />
                <AudioNarrationCard frame={frame} fps={fps} />
              </>
            }
          >
            <LogsPage rows={displayedRows} />
          </AppShell>
        </Camera>
      )}

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c7Request" />
    </AbsoluteFill>
  );
};
