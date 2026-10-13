import React from 'react';
import {ArrowUpDown, Database, Music, Sliders} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {STORY} from '../story';
import {COLORS, FONT, RADIUS, SHADOW} from '../theme';
import {Chip} from '../ui/lw';

// Chapter 9.5: Roadmap (Planning) - Upcoming capabilities.
// Cards fade in sequentially; all elements are clearly presented above the caption band.

const C = STORY.c95Roadmap;

type RoadmapCard = {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  items: readonly string[];
  footer: string;
  at: number;
};

const CARDS: readonly RoadmapCard[] = [
  // Wording follows the user's roadmap list exactly (2026-10-13); do not add features that are not on it.
  {
    title: '文生音乐',
    subtitle: 'ACE-Step 1.5',
    icon: Music,
    items: ['歌曲', '伴奏', '歌词演唱'],
    footer: '优先级：高',
    at: 20,
  },
  {
    title: '音乐编辑',
    subtitle: 'ACE-Step 工作流',
    icon: Sliders,
    items: ['歌曲续写', '局部重绘', '风格修改'],
    footer: '优先级：高',
    at: 56,
  },
  {
    title: 'Embedding',
    subtitle: 'llama.cpp / 专用向量服务',
    icon: Database,
    items: ['向量检索', 'RAG', 'Agent 记忆'],
    footer: '优先级：高',
    at: 92,
  },
  {
    title: 'Rerank',
    subtitle: '专用重排模型',
    icon: ArrowUpDown,
    items: ['检索结果重排序'],
    footer: '优先级：高',
    at: 128,
  },
];

export const RoadmapChapter: React.FC = () => {
  const frame = useCurrentFrame();

  const headerEnter = ramp(frame, 4, 18);

  return (
    <AbsoluteFill style={{fontFamily: FONT.sans}}>
      <Background />

      <div
        style={{
          position: 'absolute',
          left: 160,
          right: 160,
          top: 275,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {/* Title Header: 下一步 + Chip 规划中 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            marginBottom: 36,
            opacity: headerEnter,
            transform: `translateY(${(1 - headerEnter) * 16}px)`,
          }}
        >
          <span
            style={{
              fontSize: 52,
              fontWeight: 700,
              color: COLORS.text,
              letterSpacing: '-0.02em',
            }}
          >
            下一步
          </span>
          <Chip
            style={{
              background: 'rgba(251, 191, 36, 0.14)',
              border: '1px solid rgba(251, 191, 36, 0.35)',
              color: COLORS.warn,
              fontSize: 15,
              height: 32,
              padding: '0 14px',
              fontWeight: 600,
              borderRadius: 8,
            }}
          >
            规划中
          </Chip>
        </div>

        {/* 4 Cards Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 24,
            width: 1600,
          }}
        >
          {CARDS.map((card) => {
            const enter = ramp(frame, card.at, card.at + 14);
            const Icon = card.icon;

            return (
              <div
                key={card.title}
                style={{
                  background: COLORS.surface,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.card,
                  boxShadow: SHADOW.card,
                  padding: '26px 22px',
                  display: 'flex',
                  flexDirection: 'column',
                  height: 380,
                  boxSizing: 'border-box',
                  opacity: enter,
                  transform: `translateY(${(1 - enter) * 24}px) scale(${0.96 + 0.04 * enter})`,
                }}
              >
                {/* Top row: Icon + 规划中 badge */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 12,
                      background: COLORS.surfaceRaised,
                      border: `1px solid ${COLORS.borderStrong}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: COLORS.accentText,
                    }}
                  >
                    <Icon size={24} />
                  </div>

                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: COLORS.warn,
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: 'rgba(251, 191, 36, 0.10)',
                      border: '1px solid rgba(251, 191, 36, 0.25)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    规划中
                  </span>
                </div>

                {/* Title & Subtitle */}
                <div
                  style={{
                    fontSize: 30,
                    fontWeight: 700,
                    color: COLORS.text,
                    letterSpacing: '-0.02em',
                    marginTop: 18,
                  }}
                >
                  {card.title}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: COLORS.textMuted,
                    marginTop: 4,
                  }}
                >
                  {card.subtitle}
                </div>

                {/* Feature Items List */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    marginTop: 18,
                    flex: 1,
                  }}
                >
                  {card.items.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        fontSize: 15,
                        color: COLORS.text,
                        lineHeight: 1.4,
                      }}
                    >
                      <div
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: COLORS.accent,
                          marginTop: 8,
                          flexShrink: 0,
                        }}
                      />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>

                {/* Bottom Footer Tag */}
                <div
                  style={{
                    marginTop: 18,
                    padding: '9px 12px',
                    borderRadius: 8,
                    background: COLORS.surfaceInset,
                    border: `1px solid ${COLORS.border}`,
                    fontSize: 13,
                    color: COLORS.textMuted,
                    fontFamily: FONT.mono,
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {card.footer}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c95Roadmap" />
    </AbsoluteFill>
  );
};
