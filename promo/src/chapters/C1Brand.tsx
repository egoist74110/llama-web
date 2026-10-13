import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Pill} from '../components/Controls';
import {FlowLine} from '../components/FlowLine';
import {ClientCard, HubCard, ServiceCard} from '../components/Nodes';
import {Stage} from '../components/Stage';
import {Voice} from '../components/Voice';
import {CLIENTS, SERVICES, TIERS} from '../copy';
import {flicker, lerp, ramp, springAt} from '../lib/anim';
import {hCurve, leftEdge, rightEdge} from '../lib/geometry';
import {
  CHAOS,
  CLIENT_BOXES,
  clientAnchor,
  HUB_BOX,
  ORDER,
  ORDER_SCALE,
  serviceAnchor,
  TANGLE,
  tangleWire,
} from '../ui/networkLayout';
import {cue, STORY} from '../story';
import {COLORS, FONT, TYPE} from '../theme';
import {COMMAND, MachineTag, PAIN_BADGES, TERM_SMALL, TerminalWindow} from './C0Pain';

// Chapter 1: llama-web appears in the middle of the c0 mess, pulls the wires in and the layout
// settles into clients -> llama-web -> services. Starts exactly from the last frame of chapter 0.

const C = STORY.c1Brand;
const c1_1 = cue('c1Brand', 'c1-1');
const c1_2 = cue('c1Brand', 'c1-2');
const C0_FRAMES = STORY.c0Pain.durationInFrames;

const HUB_IN = c1_1;
const PINCH = c1_1 + 14;
const GONE = c1_1 + 36;
const SERVICES_MOVE = c1_1 + 26;
const CLIENT_WIRES = c1_1 + 40;
const SERVICE_WIRES = c1_1 + 46;
const FLOW = c1_1 + 62;

export const BrandChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // Absolute frame since chapter 0 started: keeps the flicker continuous across the cut.
  const abs = frame + C0_FRAMES;

  const hubIn = springAt(frame, fps, HUB_IN, 'pop');
  const pinch = springAt(frame, fps, PINCH, 'smooth');
  const tangleOpacity = ramp(frame, PINCH + 8, GONE, [1, 0]);
  const calm = ramp(frame, HUB_IN, PINCH + 10);
  const dotOpacity = ramp(frame, FLOW, FLOW + 12);

  const services = SERVICES.map((_, i) => {
    const m = springAt(frame, fps, SERVICES_MOVE + i * 3, 'snappy');
    return {
      cx: lerp(CHAOS[i].cx, ORDER[i].cx, m),
      cy: lerp(CHAOS[i].cy, ORDER[i].cy, m),
      rotate: lerp(CHAOS[i].rotate, 0, m),
      scale: lerp(1, ORDER_SCALE, m),
      m,
    };
  });

  const hubLeft = leftEdge(HUB_BOX);
  const hubRight = rightEdge(HUB_BOX);
  const termFade = ramp(frame, HUB_IN, HUB_IN + 18, [1, 0]);

  return (
    <AbsoluteFill style={{fontFamily: FONT.sans}}>
      <Background />
      <Stage>
        {tangleOpacity > 0
          ? TANGLE.map(({client, service}, i) => {
              const s = services[service];
              const broken = PAIN_BADGES.some((e) => e.service === service);
              return (
                <FlowLine
                  key={`t-${i}`}
                  d={tangleWire(i, clientAnchor(client), serviceAnchor(s.cx, s.cy, s.scale), pinch)}
                  color={broken && calm < 0.2 && flicker(`err-${i}`, abs, 4) > 0.7 ? COLORS.danger : COLORS.wire}
                  width={1.6}
                  opacity={0.75 * tangleOpacity * lerp(flicker(`w-${i}`, abs, 3, 0.2), 0.6, calm)}
                />
              );
            })
          : null}

        {CLIENTS.map((_, i) => {
          const start = CLIENT_WIRES + i * 4;
          return (
            <FlowLine
              key={`c-${i}`}
              d={hCurve(clientAnchor(i), {x: hubLeft.x, y: hubLeft.y + (i - 1) * 44})}
              draw={ramp(frame, start, start + 16)}
              color={COLORS.accentLine}
              width={2}
              dots={1}
              dotPeriod={48}
              dotOpacity={dotOpacity}
              phase={i * 16}
            />
          );
        })}

        {services.map((s, i) => {
          const start = SERVICE_WIRES + i * 3;
          return (
            <FlowLine
              key={`s-${i}`}
              d={hCurve(
                {x: hubRight.x, y: hubRight.y + (i - (SERVICES.length - 1) / 2) * 24},
                serviceAnchor(s.cx, s.cy, s.scale),
              )}
              draw={ramp(frame, start, start + 16)}
              color={COLORS.accentLine}
              width={2}
              dots={1}
              dotPeriod={48}
              dotOpacity={dotOpacity}
              phase={24 + i * 9}
            />
          );
        })}
      </Stage>

      {CLIENTS.map((c, i) => (
        <ClientCard key={c.kind} {...c} cx={CLIENT_BOXES[i].cx} cy={CLIENT_BOXES[i].cy} />
      ))}

      {SERVICES.map((svc, i) => {
        const s = services[i];
        const err = PAIN_BADGES.find((e) => e.service === i);
        // Error badges keep flashing until the card moves; in the column each card shows its tier.
        const badge =
          s.m < 0.5
            ? err
              ? {text: err.text, tone: 'danger' as const, opacity: flicker(`b-${i}`, abs, 5, 0.25) * (1 - s.m * 2)}
              : null
            : {
                text: TIERS[svc.tier],
                tone: svc.tier === 'native' ? ('accent' as const) : ('neutral' as const),
                opacity: ramp(s.m, 0.5, 1),
              };
        return (
          <ServiceCard key={svc.url} {...svc} cx={s.cx} cy={s.cy} rotate={s.rotate} scale={s.scale} badge={badge} />
        );
      })}

      <MachineTag opacity={ramp(frame, HUB_IN, HUB_IN + 10, [1, 0])} />
      <TerminalWindow
        {...TERM_SMALL}
        chars={COMMAND.length}
        caret={false}
        errorOpacity={1}
        opacity={termFade}
      />

      <HubCard
        cx={HUB_BOX.cx}
        cy={HUB_BOX.cy}
        scale={0.6 + 0.4 * hubIn}
        opacity={ramp(frame, HUB_IN, HUB_IN + 6)}
        glow={hubIn}
      />

      <div
        style={{
          position: 'absolute',
          left: HUB_BOX.cx,
          top: HUB_BOX.cy + HUB_BOX.h / 2 + 34,
          transform: `translate(-50%, 0) translateY(${(1 - ramp(frame, c1_2, c1_2 + 12)) * 12}px)`,
          opacity: ramp(frame, c1_2, c1_2 + 12),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
        }}
      >
        <div style={{display: 'flex', gap: 16}}>
          <Pill tone="accent" style={{fontSize: TYPE.small, padding: '8px 20px'}}>
            llama.cpp 原生管理
          </Pill>
          <Pill tone="neutral" style={{fontSize: TYPE.small, padding: '8px 20px'}}>
            独立 API 网关
          </Pill>
        </div>
        <div
          style={{
            fontSize: TYPE.small,
            color: COLORS.textMuted,
            opacity: ramp(frame, c1_2 + 20, c1_2 + 32),
            whiteSpace: 'nowrap',
          }}
        >
          一个进程 · 不装 llama.cpp 也能用
        </div>
      </div>

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c1Brand" />
    </AbsoluteFill>
  );
};
