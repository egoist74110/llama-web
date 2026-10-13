import React from 'react';
import {Check, Cpu, GitBranch, Plug} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Typewriter, typeEnd} from '../components/Typewriter';
import {Voice} from '../components/Voice';
import {ramp, springAt} from '../lib/anim';
import {COLORS, FONT, SHADOW} from '../theme';
import {cue, STORY} from '../story';
import {Chip, Field, Icon, Input, LwCard} from '../ui/lw';

// Chapter 9: the client is configured once. The client card never changes while the
// backend column switches three times. Beats are relative to narration cues.

const C = STORY.c9Client;

const c9_2 = cue('c9Client', 'c9-2');
const c9_2Dur = C.lines.find((l) => l.id === 'c9-2')?.dur ?? 120;

const BASE_URL = 'http://192.168.1.10:5001/v1';
const MODEL = 'Qwen3-8B:长上下文';
const KEY_HINT = '局域网不校验，随便填一个即可'; // i18n onboarding.gateway.client.keyValue

const BASE_START = 4;
const MODEL_START = typeEnd(BASE_URL, BASE_START, 2) + 2;
const KEY_AT = typeEnd(MODEL, MODEL_START, 2) + 1;
const CHECK_AT = KEY_AT + 5;

// Three backend switches spread over c9-2.
const STEP = Math.floor((c9_2Dur - 20) / 3);
const SWITCH = [c9_2 + 20, c9_2 + 20 + STEP, c9_2 + 20 + STEP * 2] as const;

const BACKENDS: readonly {name: string; hint: string; icon: LucideIcon}[] = [
  {name: 'llama.cpp（b11146）', hint: '本地运行', icon: Cpu},
  {name: '我的分支', hint: '本地运行', icon: GitBranch},
  {name: 'Strata（外部服务）', hint: '外部上游', icon: Plug},
];

// Whole group is laid out in native px and scaled once, centred above the caption band.
const S = 2.1;
const CARD_W = 420;
const CARD_H = 292; // matches the rendered LwCard height (checked by render)
const CONN_GAP = 56;
const PANEL_LEFT = CARD_W + CONN_GAP;
const PANEL_W = 380;
const ROW_H = 64;
const ROW_GAP = 12;
const PANEL_TOP = (CARD_H - (3 * ROW_H + 2 * ROW_GAP)) / 2 + 12;
const GROUP_W = PANEL_LEFT + PANEL_W;
const GROUP_H = CARD_H;
const CAPTION_BAND = 150;
const GROUP_LEFT = (1920 - GROUP_W * S) / 2;
const GROUP_TOP = (1080 - CAPTION_BAND - GROUP_H * S) / 2;
const rowTop = (pos: number) => PANEL_TOP + pos * (ROW_H + ROW_GAP);
const rowMid = (pos: number) => rowTop(pos) + ROW_H / 2;
const CARD_MID = CARD_H / 2;

export const ClientChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const cardIn = springAt(frame, fps, 0, 'pop');
  const keyShown = ramp(frame, KEY_AT, KEY_AT + 8);
  const checkIn = springAt(frame, fps, CHECK_AT, 'pop');
  const panelIn = ramp(frame, c9_2 - 4, c9_2 + 8);

  const active = frame >= SWITCH[2] ? 2 : frame >= SWITCH[1] ? 1 : frame >= SWITCH[0] ? 0 : -1;
  const lastSwitch = SWITCH[Math.max(active, 0) as 0 | 1 | 2];
  const flash = active >= 0 ? ramp(frame, lastSwitch, lastSwitch + 20, [1, 0]) : 0;
  // Row position (fractional) of the highlight and connector end: eased, no overshoot.
  const hiPos =
    active <= 0 ? 0 : ramp(frame, SWITCH[active as 1 | 2], SWITCH[active as 1 | 2] + 12, [active - 1, active]);
  const hiOpacity = active < 0 ? 0 : active === 0 ? ramp(frame, SWITCH[0], SWITCH[0] + 8) : 1;
  const midX = CARD_W + CONN_GAP / 2;

  return (
    <AbsoluteFill>
      <Background />

      <div
        style={{
          position: 'absolute',
          left: GROUP_LEFT,
          top: GROUP_TOP,
          width: GROUP_W,
          height: GROUP_H,
          transform: `scale(${S})`,
          transformOrigin: 'top left',
          fontFamily: FONT.sans,
        }}
      >
        {/* Client settings card: identical for the whole chapter once typed. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: CARD_W,
            height: CARD_H,
            opacity: Math.min(cardIn, 1),
            transform: `scale(${0.96 + 0.04 * Math.min(cardIn, 1)})`,
            transformOrigin: 'center',
          }}
        >
          <LwCard highlight style={{boxShadow: SHADOW.card, height: CARD_H, boxSizing: 'border-box'}}>
            <div style={{display: 'flex', alignItems: 'center', padding: '18px 20px 6px'}}>
              <div style={{flex: 1, fontSize: 15, fontWeight: 600, color: COLORS.text}}>客户端设置</div>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  background: COLORS.ok,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: `scale(${Math.min(checkIn, 1.15)})`,
                  opacity: Math.min(checkIn, 1),
                }}
              >
                <Icon icon={Check} size={15} color={COLORS.bg} style={{strokeWidth: 3}} />
              </div>
            </div>
            <div style={{padding: '10px 20px 22px', display: 'flex', flexDirection: 'column', gap: 16}}>
              <Field label="Base URL">
                <Input mono height={34}>
                  <Typewriter text={BASE_URL} start={BASE_START} framesPerChar={2} />
                </Input>
              </Field>
              <Field label="model">
                <Input mono height={34}>
                  <Typewriter text={MODEL} start={MODEL_START} framesPerChar={2} />
                </Input>
              </Field>
              <Field label="API key">
                <Input height={34}>
                  <span style={{color: COLORS.textMuted, opacity: keyShown}}>{KEY_HINT}</span>
                </Input>
              </Field>
            </div>
          </LwCard>
        </div>

        {/* Connector: card -> elbow -> current backend row. */}
        <svg
          width={GROUP_W}
          height={GROUP_H}
          style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: panelIn}}
        >
          <polyline
            points={`${CARD_W},${CARD_MID} ${midX},${CARD_MID} ${midX},${rowMid(hiPos)} ${PANEL_LEFT},${rowMid(hiPos)}`}
            fill="none"
            stroke={COLORS.wire}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <circle cx={PANEL_LEFT} cy={rowMid(hiPos)} r={4} fill={COLORS.accent} opacity={hiOpacity} />
        </svg>

        {/* Backend column. */}
        <div style={{position: 'absolute', left: PANEL_LEFT, top: PANEL_TOP - 30, opacity: panelIn}}>
          <div style={{fontSize: 13, color: COLORS.textFaint, letterSpacing: 2}}>后端</div>
        </div>
        <div style={{position: 'absolute', left: PANEL_LEFT, top: 0, width: PANEL_W, height: GROUP_H, opacity: panelIn}}>
          <div
            style={{
              position: 'absolute',
              left: -3,
              right: -3,
              top: rowTop(hiPos) - 3,
              height: ROW_H + 6,
              borderRadius: 12,
              border: `2px solid ${COLORS.accent}`,
              boxShadow: `0 0 ${20 * flash}px ${COLORS.accentLine}`,
              opacity: hiOpacity,
              boxSizing: 'border-box',
            }}
          />
          {BACKENDS.map((b, i) => {
            const on = active === i;
            return (
              <div key={b.name} style={{position: 'absolute', left: 0, right: 0, top: rowTop(i), height: ROW_H}}>
                <LwCard
                  style={{
                    height: ROW_H,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '0 16px',
                    background: on ? COLORS.surfaceRaised : COLORS.surface,
                    opacity: on ? 1 : 0.6,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: on ? COLORS.accentSoft : COLORS.surfaceInset,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: on ? COLORS.accentText : COLORS.textFaint,
                    }}
                  >
                    <Icon icon={b.icon} size={20} />
                  </div>
                  <div style={{flex: 1, fontSize: 18, fontWeight: 600, color: COLORS.text, whiteSpace: 'nowrap'}}>{b.name}</div>
                  <Chip accent={on}>{b.hint}</Chip>
                </LwCard>
              </div>
            );
          })}
        </div>
      </div>

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c9Client" />
    </AbsoluteFill>
  );
};
