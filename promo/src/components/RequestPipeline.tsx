import React from 'react';
import {CheckCircle2, Image as ImageIcon, Key, Laptop, Server, Sparkles} from 'lucide-react';
import {COLORS, FONT, RADIUS, SHADOW} from '../theme';
import {Chip} from '../ui/lw';
import {FlowLine} from './FlowLine';
import {Packet} from './Packet';

// Chapter 7: Request Pipeline ("一条请求经过什么")
// Horizontal pipeline: 客户端 → llama-web (:5001) → 图片压缩 → 附上上游 key → Strata.
// Pure component driven entirely by props.

export type RequestPipelineProps = {
  // Master progress 0..1 (can drive all animations proportionally if granular props omitted)
  progress?: number;

  // Granular overrides:
  packetT?: number; // 0..1 position of request packet along path
  packetVisible?: boolean;

  // Station highlights (0..1 or boolean)
  compressHighlight?: number;
  showCompressBadge?: boolean;

  keyHighlight?: number;
  showKeyBadge?: boolean;

  upstreamHighlight?: number;

  // Return packet / stream
  packetBackT?: number; // 0..1 position of return packet
  packetBackVisible?: boolean;

  // Stream reply card under Client (0..1 typewriter progress)
  streamProgress?: number;
  showStreamCard?: boolean;

  style?: React.CSSProperties;
};

// Architecture layout coordinates in a 1920 x 1080 canvas
// Total pipeline width spans ~85% of 1920 (1632px from x=144 to x=1776).
// Vertically centered above the bottom 150px subtitle band (y=0..930, center ~465).
const WIRE_Y = 310;
const CARD_Y = 510;

const NODES = {
  client: {x: 300, y: CARD_Y, w: 312, h: 184},
  hub: {x: 630, y: CARD_Y, w: 312, h: 190},
  compress: {x: 960, y: CARD_Y, w: 312, h: 184},
  key: {x: 1290, y: CARD_Y, w: 312, h: 184},
  strata: {x: 1620, y: CARD_Y, w: 312, h: 184},
} as const;

const FORWARD_PATH = `M ${NODES.client.x} ${WIRE_Y} L ${NODES.strata.x} ${WIRE_Y}`;
const REVERSE_PATH = `M ${NODES.strata.x} ${WIRE_Y} L ${NODES.client.x} ${WIRE_Y}`;

const STREAM_LINES = [
  '已收到图片并完成透明预处理。',
  '最长边已压缩至 896px，密钥由网关代填。',
  '识别结果：图表数据完整，所有服务正常。',
];
const STREAM_FULL_TEXT = STREAM_LINES.join('\n');

export const RequestPipeline: React.FC<RequestPipelineProps> = ({
  progress = 0,
  packetT,
  packetVisible,
  compressHighlight,
  showCompressBadge,
  keyHighlight,
  showKeyBadge,
  upstreamHighlight,
  packetBackT,
  packetBackVisible,
  streamProgress,
  showStreamCard,
  style,
}) => {
  const effectivePacketT =
    packetT !== undefined
      ? packetT
      : Math.min(1, Math.max(0, progress / 0.62));

  const effectivePacketVis =
    packetVisible !== undefined
      ? packetVisible
      : progress > 0.02 && progress < 0.68;

  const effectiveCompressHi =
    compressHighlight !== undefined
      ? compressHighlight
      : effectivePacketT >= 0.44 && effectivePacketT <= 0.62
        ? 1
        : effectivePacketT > 0.62
          ? 0.4
          : 0;

  const effectiveCompressBadge =
    showCompressBadge !== undefined ? showCompressBadge : effectivePacketT >= 0.46;

  const effectiveKeyHi =
    keyHighlight !== undefined
      ? keyHighlight
      : effectivePacketT >= 0.68 && effectivePacketT <= 0.86
        ? 1
        : effectivePacketT > 0.86
          ? 0.4
          : 0;

  const effectiveKeyBadge =
    showKeyBadge !== undefined ? showKeyBadge : effectivePacketT >= 0.70;

  const effectiveUpstreamHi =
    upstreamHighlight !== undefined
      ? upstreamHighlight
      : effectivePacketT >= 0.95 || (progress >= 0.60 && progress <= 0.80)
        ? 1
        : progress > 0.80
          ? 0.3
          : 0;

  const effectivePacketBackT =
    packetBackT !== undefined
      ? packetBackT
      : Math.min(1, Math.max(0, (progress - 0.62) / 0.20));

  const effectivePacketBackVis =
    packetBackVisible !== undefined
      ? packetBackVisible
      : progress >= 0.63 && progress <= 0.84;

  const effectiveStreamProg =
    streamProgress !== undefined
      ? streamProgress
      : Math.min(1, Math.max(0, (progress - 0.70) / 0.28));

  const effectiveStreamCard =
    showStreamCard !== undefined ? showStreamCard : progress >= 0.68;

  // Typewriter text
  const totalChars = STREAM_FULL_TEXT.length;
  const visibleChars = Math.round(effectiveStreamProg * totalChars);
  const currentStreamText = STREAM_FULL_TEXT.slice(0, visibleChars);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: COLORS.bg,
        overflow: 'hidden',
        fontFamily: FONT.sans,
        ...style,
      }}
    >
      {/* Background glow around hub */}
      <div
        style={{
          position: 'absolute',
          left: NODES.hub.x - 300,
          top: CARD_Y - 250,
          width: 600,
          height: 500,
          background: 'radial-gradient(circle, rgba(79,91,213,0.14) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Title header */}
      <div
        style={{
          position: 'absolute',
          top: 68,
          left: 0,
          right: 0,
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{display: 'inline-flex', marginBottom: 10}}>
          <Chip accent style={{fontSize: 14, padding: '3px 12px'}}>透明转发 · 统一预处理</Chip>
        </div>
        <div style={{fontSize: 32, fontWeight: 700, color: COLORS.text, letterSpacing: '-0.02em'}}>
          每个请求，都走同一条链路
        </div>
        <div style={{fontSize: 16, color: COLORS.textMuted, marginTop: 8}}>
          图片自动压缩 · 上游密钥网关代填 · 客户端零感知
        </div>
      </div>

      {/* SVG Wire & Bus Drop Lines */}
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: 1920,
          height: 1080,
          pointerEvents: 'none',
        }}
      >
        {/* Main horizontal bus line */}
        <FlowLine
          d={FORWARD_PATH}
          color={COLORS.accentLine}
          width={3.5}
          opacity={0.9}
          dash={6}
          speed={1.5}
        />

        {/* Vertical junction drop lines connecting bus to station cards */}
        {Object.entries(NODES).map(([keyName, n]) => {
          const isHi =
            keyName === 'compress'
              ? effectiveCompressHi > 0.5
              : keyName === 'key'
                ? effectiveKeyHi > 0.5
                : keyName === 'strata'
                  ? effectiveUpstreamHi > 0.5
                  : false;

          const topCardY = n.y - n.h / 2;

          return (
            <g key={keyName}>
              {/* Vertical connector */}
              <line
                x1={n.x}
                y1={WIRE_Y}
                x2={n.x}
                y2={topCardY}
                stroke={isHi ? COLORS.accent : COLORS.borderStrong}
                strokeWidth={2.5}
                strokeDasharray="4 4"
                opacity={0.85}
              />
              {/* Bus node circle */}
              <circle
                cx={n.x}
                cy={WIRE_Y}
                r={isHi ? 7 : 5}
                fill={isHi ? COLORS.accent : COLORS.borderStrong}
              />
            </g>
          );
        })}
      </svg>

      {/* Node 1: 客户端 */}
      <div
        style={{
          position: 'absolute',
          left: NODES.client.x - NODES.client.w / 2,
          top: NODES.client.y - NODES.client.h / 2,
          width: NODES.client.w,
          height: NODES.client.h,
          borderRadius: RADIUS.card,
          background: COLORS.surface,
          border: `1px solid ${effectiveStreamProg > 0 ? COLORS.accent : COLORS.borderStrong}`,
          boxShadow: effectiveStreamProg > 0 ? `0 0 32px ${COLORS.accentSoft}, ${SHADOW.card}` : SHADOW.card,
          padding: '22px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: COLORS.surfaceRaised,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: COLORS.textMuted,
                flexShrink: 0,
              }}
            >
              <Laptop size={26} />
            </div>
            <div>
              <div style={{fontSize: 24, fontWeight: 700, color: COLORS.text}}>客户端</div>
              <div style={{fontSize: 15.5, color: COLORS.textFaint, marginTop: 2}}>酒馆 / 聊天软件</div>
            </div>
          </div>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
          <span style={{fontFamily: FONT.mono, fontSize: 14.5, color: COLORS.accentText}}>
            POST /v1/chat/completions
          </span>
        </div>
      </div>

      {/* Node 2: llama-web (:5001) */}
      <div
        style={{
          position: 'absolute',
          left: NODES.hub.x - NODES.hub.w / 2,
          top: NODES.hub.y - NODES.hub.h / 2,
          width: NODES.hub.w,
          height: NODES.hub.h,
          borderRadius: RADIUS.card,
          background: COLORS.surfaceRaised,
          border: `1.5px solid ${COLORS.accent}`,
          boxShadow: `0 0 36px ${COLORS.accentSoft}, ${SHADOW.raised}`,
          padding: '22px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            {/* Heartbeat ECG icon */}
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: COLORS.accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={COLORS.white} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 13h3.5l2.2-6 3.6 11 2.3-5H20" />
              </svg>
            </div>
            <div>
              <div style={{fontSize: 25, fontWeight: 700, color: COLORS.text, letterSpacing: '-0.01em'}}>llama-web</div>
              <div style={{fontSize: 15.5, color: COLORS.textFaint, marginTop: 2}}>统一网关</div>
            </div>
          </div>
          <Chip accent mono style={{height: 30, fontSize: 14.5, padding: '0 10px'}}>:5001</Chip>
        </div>
        <div style={{fontSize: 15.5, color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 8}}>
          <span style={{width: 8, height: 8, borderRadius: 99, background: COLORS.ok}} />
          <span>请求中继 · 透明预处理</span>
        </div>
      </div>

      {/* Node 3: Station 1 - 图片压缩 */}
      <div
        style={{
          position: 'absolute',
          left: NODES.compress.x - NODES.compress.w / 2,
          top: NODES.compress.y - NODES.compress.h / 2,
          width: NODES.compress.w,
          height: NODES.compress.h,
          borderRadius: RADIUS.card,
          background: COLORS.surface,
          border: `1.5px solid ${effectiveCompressHi > 0.5 ? COLORS.accent : COLORS.border}`,
          boxShadow: effectiveCompressHi > 0.5 ? `0 0 32px ${COLORS.accentSoft}, ${SHADOW.card}` : SHADOW.card,
          padding: '22px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          transform: `scale(${1 + 0.03 * effectiveCompressHi})`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: effectiveCompressHi > 0.5 ? COLORS.accentSoft : COLORS.surfaceInset,
                border: `1px solid ${effectiveCompressHi > 0.5 ? COLORS.accent : COLORS.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: effectiveCompressHi > 0.5 ? COLORS.accentText : COLORS.textMuted,
                flexShrink: 0,
              }}
            >
              <ImageIcon size={26} />
            </div>
            <div>
              <div style={{fontSize: 24, fontWeight: 700, color: COLORS.text}}>图片压缩</div>
              <div style={{fontSize: 15.5, color: COLORS.textFaint, marginTop: 2}}>第一站 · 节省显存</div>
            </div>
          </div>
          <span style={{fontSize: 15, fontFamily: FONT.mono, color: COLORS.textFaint}}>sharp</span>
        </div>

        {/* Small text / popping badge */}
        <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
          {effectiveCompressBadge ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'rgba(74, 222, 128, 0.18)',
                border: `1.5px solid rgba(74, 222, 128, 0.55)`,
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 18.5,
                fontWeight: 700,
                color: COLORS.ok,
                fontFamily: FONT.mono,
                boxShadow: '0 0 16px rgba(74, 222, 128, 0.25)',
              }}
            >
              <CheckCircle2 size={19} />
              3024 → 896px
            </span>
          ) : (
            <span style={{fontSize: 15.5, color: COLORS.textFaint}}>最长边 896px · JPEG 90</span>
          )}
        </div>
      </div>

      {/* Node 4: Station 2 - 附上上游 key */}
      <div
        style={{
          position: 'absolute',
          left: NODES.key.x - NODES.key.w / 2,
          top: NODES.key.y - NODES.key.h / 2,
          width: NODES.key.w,
          height: NODES.key.h,
          borderRadius: RADIUS.card,
          background: COLORS.surface,
          border: `1.5px solid ${effectiveKeyHi > 0.5 ? COLORS.accent : COLORS.border}`,
          boxShadow: effectiveKeyHi > 0.5 ? `0 0 32px ${COLORS.accentSoft}, ${SHADOW.card}` : SHADOW.card,
          padding: '22px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          transform: `scale(${1 + 0.03 * effectiveKeyHi})`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: effectiveKeyHi > 0.5 ? COLORS.accentSoft : COLORS.surfaceInset,
                border: `1px solid ${effectiveKeyHi > 0.5 ? COLORS.accent : COLORS.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: effectiveKeyHi > 0.5 ? COLORS.accentText : COLORS.textMuted,
                flexShrink: 0,
              }}
            >
              <Key size={26} />
            </div>
            <div>
              <div style={{fontSize: 24, fontWeight: 700, color: COLORS.text}}>附上上游 key</div>
              <div style={{fontSize: 15.5, color: COLORS.textFaint, marginTop: 2}}>第二站 · 密钥代填</div>
            </div>
          </div>
          <span style={{fontSize: 15, color: COLORS.ok, fontWeight: 600}}>已保存</span>
        </div>

        {/* Popping masked key badge */}
        <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
          {effectiveKeyBadge ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: COLORS.accentSoft,
                border: `1.5px solid ${COLORS.accentLine}`,
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 18.5,
                fontWeight: 700,
                color: COLORS.accentText,
                fontFamily: FONT.mono,
                boxShadow: `0 0 16px ${COLORS.accentSoft}`,
              }}
            >
              sk-••••••••9f2d
            </span>
          ) : (
            <span style={{fontSize: 15.5, color: COLORS.textFaint}}>客户端无需持有 key</span>
          )}
        </div>
      </div>

      {/* Node 5: Strata (上游) */}
      <div
        style={{
          position: 'absolute',
          left: NODES.strata.x - NODES.strata.w / 2,
          top: NODES.strata.y - NODES.strata.h / 2,
          width: NODES.strata.w,
          height: NODES.strata.h,
          borderRadius: RADIUS.card,
          background: COLORS.surface,
          border: `1px solid ${effectiveUpstreamHi > 0.5 ? COLORS.accent : COLORS.borderStrong}`,
          boxShadow: effectiveUpstreamHi > 0.5 ? `0 0 36px ${COLORS.accentSoft}, ${SHADOW.card}` : SHADOW.card,
          padding: '22px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          transform: `scale(${1 + 0.04 * effectiveUpstreamHi})`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: effectiveUpstreamHi > 0.5 ? COLORS.accentSoft : COLORS.surfaceInset,
                border: `1px solid ${effectiveUpstreamHi > 0.5 ? COLORS.accent : COLORS.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: effectiveUpstreamHi > 0.5 ? COLORS.accentText : COLORS.textMuted,
                flexShrink: 0,
              }}
            >
              <Server size={26} />
            </div>
            <div>
              <div style={{fontSize: 25, fontWeight: 700, color: COLORS.text}}>Strata</div>
              <div style={{fontSize: 15.5, color: COLORS.textFaint, marginTop: 2}}>外部上游服务</div>
            </div>
          </div>
          <span style={{fontSize: 15, color: COLORS.ok, fontWeight: 600}}>在线</span>
        </div>
        <div style={{fontFamily: FONT.mono, fontSize: 15.5, color: COLORS.textMuted}}>
          :8080/v1 · qwen3-32b
        </div>
      </div>

      {/* Traveling Request Packet (Client -> Strata) along the bus */}
      {effectivePacketVis ? (
        <Packet
          d={FORWARD_PATH}
          t={effectivePacketT}
          label="请求 (带图)"
          color={COLORS.flow}
          scale={1.65}
        />
      ) : null}

      {/* Traveling Return Packet (Strata -> Client) along the bus */}
      {effectivePacketBackVis ? (
        <Packet
          d={REVERSE_PATH}
          t={effectivePacketBackT}
          label="流式输出 SSE"
          color={COLORS.flow}
          scale={1.65}
        />
      ) : null}

      {/* Stream Response Card under Client */}
      {effectiveStreamCard ? (
        <div
          style={{
            position: 'absolute',
            left: NODES.client.x - NODES.client.w / 2,
            top: CARD_Y + NODES.client.h / 2 + 20,
            width: 440,
            borderRadius: RADIUS.card,
            background: COLORS.surfaceRaised,
            border: `1px solid ${COLORS.accent}`,
            boxShadow: `0 0 32px ${COLORS.accentSoft}, ${SHADOW.raised}`,
            padding: '18px 22px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            zIndex: 10,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <Sparkles size={18} color={COLORS.accent} />
              <span style={{fontSize: 16, fontWeight: 600, color: COLORS.text}}>
                流式返回 · SSE
              </span>
            </div>
            <Chip accent mono style={{height: 26, fontSize: 12.5, padding: '0 8px'}}>
              Strata-qwen3-32b
            </Chip>
          </div>

          <div
            style={{
              background: COLORS.surfaceInset,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: '12px 16px',
              fontFamily: FONT.sans,
              fontSize: 14.5,
              color: COLORS.text,
              lineHeight: 1.6,
              whiteSpace: 'pre-line',
              minHeight: 70,
            }}
          >
            {currentStreamText}
            {effectiveStreamProg < 1 ? (
              <span
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 16,
                  background: COLORS.accent,
                  marginLeft: 3,
                  verticalAlign: 'text-bottom',
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
