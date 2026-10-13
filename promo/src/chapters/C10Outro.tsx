import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {AppIcon} from '../components/AppIcon';
import {Background} from '../components/Background';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {cue, STORY} from '../story';
import {COLORS, FONT, TYPE} from '../theme';

// Chapter 10: outro. Items fade in one after another; the last second fades to the background.

const C = STORY.c10Outro;
const c10_1 = cue('c10Outro', 'c10-1');
const c10_2 = cue('c10Outro', 'c10-2');

const T = {
  icon: 4,
  title: c10_1,
  sub: c10_1 + 4,
  platform: c10_1 + 10,
  facts: c10_1 + 18,
  slogan: c10_2,
} as const;

const fade = (frame: number, at: number) => ({
  opacity: ramp(frame, at, at + 14),
  transform: `translateY(${ramp(frame, at, at + 14, [14, 0])}px)`,
});

export const OutroChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const end = C.durationInFrames;
  const out = ramp(frame, end - 30, end, [1, 0]);

  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{opacity: out}}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 110,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            fontFamily: FONT.sans,
            textAlign: 'center',
          }}
        >
          <div style={fade(frame, T.icon)}>
            <AppIcon size={168} />
          </div>
          <div style={{...fade(frame, T.title), marginTop: 28, fontSize: TYPE.hero, fontWeight: 700, color: COLORS.text, letterSpacing: -2}}>
            llama-web
          </div>
          <div style={{...fade(frame, T.sub), marginTop: 6, fontSize: 34, color: COLORS.accentText, letterSpacing: 0.5}}>
            Unified LLM Gateway &amp; llama.cpp Manager
          </div>
          <div style={{...fade(frame, T.platform), marginTop: 44, fontSize: 28, color: COLORS.textMuted}}>
            Windows 11 x64（NVIDIA / CPU）· macOS 13+（Apple Silicon）
          </div>
          <div style={{...fade(frame, T.facts), marginTop: 14, fontSize: 28, color: COLORS.textMuted}}>
            安装包自带运行环境 · MIT 开源 · github.com/egoist74110/llama-web
          </div>
          <div style={{...fade(frame, T.slogan), marginTop: 64, fontSize: 52, fontWeight: 600, color: COLORS.text}}>
            把复杂留在工具里，把简单留给你。
          </div>
        </div>
      </AbsoluteFill>
      <Voice chapter="c10Outro" />
    </AbsoluteFill>
  );
};
