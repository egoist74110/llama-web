import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {FlowLine} from '../components/FlowLine';
import {ClientCard, ServiceCard} from '../components/Nodes';
import {Stage} from '../components/Stage';
import {Voice} from '../components/Voice';
import {CLIENTS, SERVICES} from '../copy';
import {caretOn, flicker, lerp, ramp, springAt, typedCount} from '../lib/anim';
import {CHAOS, CLIENT_BOXES, clientAnchor, serviceAnchor, TANGLE, tangleWire} from '../ui/networkLayout';
import {cue, STORY} from '../story';
import {COLORS, FONT, RADIUS, SHADOW} from '../theme';

// Chapter 0: the pain. A terminal types a very long command and fails; then the camera pulls back
// to show every client wired by hand to every service. Chapter 1 starts from the final frame.

const C = STORY.c0Pain;
const c0_1 = cue('c0Pain', 'c0-1');
const c0_2 = cue('c0Pain', 'c0-2');
const c0_3 = cue('c0Pain', 'c0-3');

export const COMMAND =
  'llama-server --model X:\\models\\Qwen3-8B-Q4_K_M.gguf --ctx-size 32768 --n-gpu-layers 99 --flash-attn on ' +
  '--cache-type-k q8_0 --cache-type-v q8_0 --threads 8 --batch-size 2048 --ubatch-size 512 --parallel 2 ' +
  '--jinja --chat-template-kind auto --host 127.0.0.1 --port 8081';
export const ERROR_TEXT = "error: invalid argument for '--chat-template-kind'";

const TERM_W = 1100;
const TERM_H = 540;
// Big (centered) and small (parked bottom-left) terminal placements.
export const TERM_BIG = {cx: 960, cy: 430, scale: 1} as const;
export const TERM_SMALL = {cx: 250, cy: 818, scale: 0.36} as const;

export const TerminalWindow: React.FC<{
  chars: number;
  caret: boolean;
  errorOpacity: number;
  cx: number;
  cy: number;
  scale: number;
  opacity?: number;
}> = ({chars, caret, errorOpacity, cx, cy, scale, opacity = 1}) => (
  <div
    style={{
      position: 'absolute',
      left: cx - TERM_W / 2,
      top: cy - TERM_H / 2,
      width: TERM_W,
      height: TERM_H,
      transform: `scale(${scale})`,
      opacity,
      boxSizing: 'border-box',
      borderRadius: RADIUS.card,
      background: COLORS.term,
      border: `1px solid ${COLORS.borderStrong}`,
      boxShadow: SHADOW.raised,
      overflow: 'hidden',
      fontFamily: FONT.mono,
    }}
  >
    <div
      style={{
        height: 52,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 20px',
        background: COLORS.surfaceRaised,
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {[COLORS.danger, COLORS.warn, COLORS.ok].map((c) => (
        <span key={c} style={{width: 14, height: 14, borderRadius: 7, background: c, opacity: 0.85}} />
      ))}
      <span style={{marginLeft: 16, fontSize: 20, color: COLORS.textFaint}}>终端</span>
    </div>
    <div style={{padding: '26px 30px', fontSize: 28, lineHeight: 1.5, color: COLORS.text}}>
      <div style={{whiteSpace: 'pre-wrap', wordBreak: 'break-all'}}>
        <span style={{color: COLORS.accentText}}>PS X:\llama.cpp&gt; </span>
        {COMMAND.slice(0, chars)}
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 30,
            marginLeft: 3,
            verticalAlign: 'text-bottom',
            background: COLORS.accentText,
            opacity: caret ? 1 : 0,
          }}
        />
      </div>
      <div style={{marginTop: 14, color: COLORS.danger, opacity: errorOpacity}}>{ERROR_TEXT}</div>
    </div>
  </div>
);

// Small label under the NInfer card (it runs on another, Linux-only machine).
export const MachineTag: React.FC<{opacity: number}> = ({opacity}) => (
  <div
    style={{
      position: 'absolute',
      left: CHAOS[5].cx,
      top: CHAOS[5].cy + 84,
      transform: 'translateX(-50%)',
      opacity,
      padding: '4px 14px',
      borderRadius: RADIUS.pill,
      border: `1px solid ${COLORS.border}`,
      background: COLORS.surfaceInset,
      color: COLORS.textMuted,
      fontSize: 18,
      whiteSpace: 'nowrap',
    }}
  >
    另一台 Linux 机器
  </div>
);

// Two services flash HTTP errors while the wires are tangled.
export const PAIN_BADGES: readonly {service: number; text: string}[] = [
  {service: 1, text: '401'},
  {service: 3, text: '404'},
  {service: 4, text: '401'},
];

const TYPE_FPC = 0.22;
export const TYPE_DONE = c0_1 + Math.ceil(COMMAND.length * TYPE_FPC);
const ERROR_AT = TYPE_DONE + 4;
const PULL = c0_2;
const CLIENTS_AT = c0_2 + 4;
const SERVICES_AT = c0_2 + 18;
const WIRES_AT = c0_3 - 6;
const ERRORS_AT = c0_3 + 20;

export const PainChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const chars = typedCount(frame, c0_1, COMMAND.length, TYPE_FPC);
  const typing = frame >= c0_1 && chars < COMMAND.length;
  const caret = frame < c0_1 || typing || (frame < ERROR_AT + 40 && caretOn(frame));
  const errorOpacity = frame >= ERROR_AT ? ramp(frame, ERROR_AT, ERROR_AT + 4) : 0;

  const pull = springAt(frame, fps, PULL, 'snappy');
  const term = {
    cx: lerp(TERM_BIG.cx, TERM_SMALL.cx, pull),
    cy: lerp(TERM_BIG.cy, TERM_SMALL.cy, pull),
    scale: lerp(TERM_BIG.scale, TERM_SMALL.scale, pull),
  };

  return (
    <AbsoluteFill style={{fontFamily: FONT.sans}}>
      <Background />
      <Stage>
        {TANGLE.map(({client, service}, i) => {
          const start = WIRES_AT + i * 0.8;
          const draw = ramp(frame, start, start + 16);
          const p = CHAOS[service];
          const broken = PAIN_BADGES.some((e) => e.service === service) && frame >= ERRORS_AT;
          return (
            <FlowLine
              key={i}
              d={tangleWire(i, clientAnchor(client), serviceAnchor(p.cx, p.cy))}
              draw={draw}
              color={broken && flicker(`err-${i}`, frame, 4) > 0.7 ? COLORS.danger : COLORS.wire}
              width={1.6}
              opacity={0.75 * flicker(`w-${i}`, frame, 3, 0.2)}
            />
          );
        })}
      </Stage>

      {CLIENTS.map((c, i) => {
        const at = CLIENTS_AT + i * 5;
        return (
          <ClientCard
            key={c.kind}
            {...c}
            cx={CLIENT_BOXES[i].cx}
            cy={CLIENT_BOXES[i].cy}
            scale={0.85 + 0.15 * springAt(frame, fps, at, 'pop')}
            opacity={ramp(frame, at, at + 8)}
          />
        );
      })}

      {SERVICES.map((svc, i) => {
        const at = SERVICES_AT + i * 9;
        const s = springAt(frame, fps, at, 'pop');
        const p = CHAOS[i];
        const err = PAIN_BADGES.find((e) => e.service === i);
        return (
          <ServiceCard
            key={svc.url}
            {...svc}
                        cx={p.cx}
            cy={p.cy + (1 - s) * 30}
            rotate={p.rotate}
            scale={0.85 + 0.15 * s}
            opacity={ramp(frame, at, at + 8)}
            badge={
              err && frame >= ERRORS_AT
                ? {text: err.text, tone: 'danger', opacity: flicker(`b-${i}`, frame, 5, 0.25)}
                : null
            }
          />
        );
      })}

      <MachineTag opacity={ramp(frame, SERVICES_AT + 5 * 9 + 6, SERVICES_AT + 5 * 9 + 14)} />
      <TerminalWindow {...term} chars={chars} caret={caret} errorOpacity={errorOpacity} />

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c0Pain" />
    </AbsoluteFill>
  );
};
