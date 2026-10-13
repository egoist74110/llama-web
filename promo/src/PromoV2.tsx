import React from 'react';
import {AbsoluteFill, interpolate, Sequence, useCurrentFrame} from 'remotion';
import {BrandChapter} from './chapters/C1Brand';
import {PainChapter} from './chapters/C0Pain';
import {SetupChapter} from './chapters/C2Setup';
import {ModelsChapter} from './chapters/C3Models';
import {ProfilesChapter} from './chapters/C4Profiles';
import {RuntimeChapter} from './chapters/C5Runtime';
import {ConnectionsChapter} from './chapters/C6Connections';
import {RequestChapter} from './chapters/C7Request';
import {PublicChapter} from './chapters/C8Public';
import {ClientChapter} from './chapters/C9Client';
import {RoadmapChapter} from './chapters/C95Roadmap';
import {OutroChapter} from './chapters/C10Outro';
import {CHAPTER_ORDER, ChapterId, STORY, STORY_FRAMES} from './story';

const CHAPTERS: Record<ChapterId, React.FC> = {
  c0Pain: PainChapter,
  c1Brand: BrandChapter,
  c2Setup: SetupChapter,
  c3Models: ModelsChapter,
  c4Profiles: ProfilesChapter,
  c5Runtime: RuntimeChapter,
  c6Connections: ConnectionsChapter,
  c7Request: RequestChapter,
  c8Public: PublicChapter,
  c9Client: ClientChapter,
  c95Roadmap: RoadmapChapter,
  c10Outro: OutroChapter,
};

export const TRANSITION_FRAMES = 12;

export const PROMO_V2_CHAPTER_STARTS: Record<ChapterId, number> = (() => {
  const starts = {} as Record<ChapterId, number>;
  let currentStart = 0;
  for (let i = 0; i < CHAPTER_ORDER.length; i++) {
    const id = CHAPTER_ORDER[i];
    starts[id] = currentStart;
    const dur = STORY[id].durationInFrames;
    currentStart += dur - (i < CHAPTER_ORDER.length - 1 ? TRANSITION_FRAMES : 0);
  }
  return starts;
})();

export const PROMO_V2_FRAMES =
  STORY_FRAMES - (CHAPTER_ORDER.length - 1) * TRANSITION_FRAMES;

const ChapterSequence: React.FC<{
  Chapter: React.FC;
  isFirst: boolean;
}> = ({Chapter, isFirst}) => {
  const frame = useCurrentFrame();
  const opacity = isFirst
    ? 1
    : interpolate(frame, [0, TRANSITION_FRAMES], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  return (
    <AbsoluteFill style={{opacity}}>
      <Chapter />
    </AbsoluteFill>
  );
};

// The full v2 film: chapters in story order with 12-frame crossfades between them.
export const PromoV2: React.FC = () => (
  <AbsoluteFill>
    {CHAPTER_ORDER.map((id, index) => {
      const Chapter = CHAPTERS[id];
      const from = PROMO_V2_CHAPTER_STARTS[id];
      const dur = STORY[id].durationInFrames;
      return (
        <Sequence
          key={id}
          from={from}
          durationInFrames={dur}
        >
          <ChapterSequence Chapter={Chapter} isFirst={index === 0} />
        </Sequence>
      );
    })}
  </AbsoluteFill>
);
