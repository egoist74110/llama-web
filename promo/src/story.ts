// The v2 story: chapter order, durations, lines and narration captions.
// Timeline is driven by narration audio metadata in vo-manifest.json.

import type {CaptionLine} from './components/Captions';
import narrationData from './narration.json';
import manifestData from './vo-manifest.json';

export type ChapterId =
  | 'c0Pain'
  | 'c1Brand'
  | 'c2Setup'
  | 'c3Models'
  | 'c4Profiles'
  | 'c5Runtime'
  | 'c6Connections'
  | 'c7Request'
  | 'c8Public'
  | 'c9Client'
  | 'c95Roadmap'
  | 'c10Outro';

export const CHAPTER_ORDER: readonly ChapterId[] = [
  'c0Pain',
  'c1Brand',
  'c2Setup',
  'c3Models',
  'c4Profiles',
  'c5Runtime',
  'c6Connections',
  'c7Request',
  'c8Public',
  'c9Client',
  'c95Roadmap',
  'c10Outro',
];

export type StoryLine = {
  id: string;
  text: string;
  at: number;
  dur: number;
};

export type ChapterStory = {
  title: string;
  durationInFrames: number;
  lines: readonly StoryLine[];
  captions: readonly CaptionLine[];
};

type ChapterConfig = {
  holds?: Partial<Record<string, number>>;
  minFrames?: number;
};

const CHAPTER_TITLES: Record<ChapterId, string> = {
  c0Pain: '0 开场：痛点',
  c1Brand: '1 品牌：一个入口',
  c2Setup: '2 新手引导',
  c3Models: '3 模型：扫描、参数、预估',
  c4Profiles: '4 方案与自动切换',
  c5Runtime: '5 llama.cpp 版本与变体',
  c6Connections: '6 接入其他引擎（有限管理）',
  c7Request: '7 一条请求经过什么',
  c8Public: '8 公网访问',
  c9Client: '9 客户端只配一次',
  c95Roadmap: '9.5 路线图（规划中）',
  c10Outro: '10 收尾',
};

// Holds per chapter (extra frames after a line to leave time for visuals).
const CHAPTER_CONFIGS: Partial<Record<ChapterId, ChapterConfig>> = {
  c2Setup: {
    holds: {
      // Hold after c2-3 so download finishes and "已安装：b11146" stays settled before c2-4 begins
      'c2-3': 15,
    },
  },
  c3Models: {
    holds: {
      // Hold after c3-5 so the complete command preview stays settled
      'c3-5': 15,
    },
  },
  c4Profiles: {
    holds: {
      // Hold after c4-2 so loading progress bar reaches 100% and ready state settles
      'c4-2': 20,
      // Hold after c4-3 so queue count, recent event and transition settle
      'c4-3': 15,
      // Hold after c4-4 so speed curve can be drawn and viewed
      'c4-4': 25,
    },
  },
  c5Runtime: {
    holds: {
      // Hold after c5-2 so modal completion (confirmation, preview, adding) and the new version row settle
      'c5-2': 40,
    },
  },
  c6Connections: {
    holds: {
      // Hold after c6-2 so Strata start/stop sequence settles cleanly
      'c6-2': 10,
      // Hold after c6-4 so the 3-column TierChart has time to be viewed completely
      'c6-4': 25,
    },
  },
  c7Request: {
    holds: {
      // Hold after c7-2 so stream response text typewriting finishes and is viewed
      'c7-2': 20,
      // Hold after c7-5 so TTS card settles before c7-6 begins
      'c7-5': 15,
      // Hold after c7-6 so the added subtitle and MOSS highlight settle before chapter end
      'c7-6': 35,
    },
  },
  c9Client: {
    holds: {
      // Hold after c9-1 so the slower typing and the check mark finish within the line
      'c9-1': 40,
    },
  },
  c95Roadmap: {
    minFrames: 210,
  },
  c10Outro: {
    // About 8 seconds in total so the closing card can breathe
    minFrames: 240,
  },
  c8Public: {
    holds: {
      // Hold after c8-1 so the green "隧道已连通" state settles and is seen clearly
      'c8-1': 35,
      // Hold after c8-2 so the highlighted client address and keys settle
      'c8-2': 15,
    },
  },
};

const LEAD = 15;
const GAP = 8;
const TAIL = 30;
const FPS = 30;

type ManifestEntry = {
  hash: string;
  seconds: number;
};

const narration = narrationData as {
  chapters: Record<string, Array<{id: string; text: string; say?: string}>>;
};
const manifest = manifestData as Record<string, ManifestEntry>;

function buildStory(): Record<ChapterId, ChapterStory> {
  const result = {} as Record<ChapterId, ChapterStory>;

  for (const ch of CHAPTER_ORDER) {
    const rawItems = narration.chapters[ch] ?? [];
    const config = CHAPTER_CONFIGS[ch] ?? {};
    const holds = config.holds ?? {};

    let currentAt = LEAD;
    const lines: StoryLine[] = [];

    for (const item of rawItems) {
      const entry = manifest[item.id];
      const seconds = entry?.seconds ?? 0;
      const dur = Math.ceil(seconds * FPS);
      const at = currentAt;

      lines.push({
        id: item.id,
        text: item.text,
        at,
        dur,
      });

      const hold = holds[item.id] ?? 0;
      currentAt = at + dur + GAP + hold;
    }

    const lastLine = lines[lines.length - 1];
    const lastHold = lastLine ? (holds[lastLine.id] ?? 0) : 0;
    const rawDuration = lastLine ? lastLine.at + lastLine.dur + lastHold + TAIL : TAIL;
    const durationInFrames = Math.max(rawDuration, config.minFrames ?? 0);

    const captions: CaptionLine[] = lines.map((l) => ({
      at: l.at,
      zh: l.text,
    }));

    result[ch] = {
      title: CHAPTER_TITLES[ch],
      durationInFrames,
      lines,
      captions,
    };
  }

  return result;
}

export const STORY: Record<ChapterId, ChapterStory> = buildStory();

export const STORY_FRAMES = CHAPTER_ORDER.reduce((n, id) => n + STORY[id].durationInFrames, 0);

export function cue(chapter: ChapterId, id: string): number;
export function cue(id: string): number;
export function cue(arg1: ChapterId | string, arg2?: string): number {
  if (arg2 !== undefined) {
    const ch = arg1 as ChapterId;
    const story = STORY[ch];
    if (!story) {
      throw new Error(`Chapter not found: ${ch}`);
    }
    const line = story.lines.find((l) => l.id === arg2);
    if (!line) {
      throw new Error(`Cue not found: ${arg2} in chapter ${ch}`);
    }
    return line.at;
  }

  const id = arg1;
  for (const ch of CHAPTER_ORDER) {
    const line = STORY[ch]?.lines.find((l) => l.id === id);
    if (line) {
      return line.at;
    }
  }
  throw new Error(`Cue not found: ${id}`);
}
