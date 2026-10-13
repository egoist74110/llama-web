import React from 'react';
import {useCurrentFrame} from 'remotion';
import {ramp} from '../lib/anim';
import {COLORS, FONT} from '../theme';

export type CaptionLine = {at: number; zh: string};

// Narration captions over full-frame app footage: one line at a time on a dark band at the bottom.
// Each line shows from its `at` until the next line's `at` (or `end`).
export const Captions: React.FC<{lines: readonly CaptionLine[]; end: number}> = ({lines, end}) => {
  const frame = useCurrentFrame();
  const idx = lines.findIndex((l, i) => frame >= l.at && frame < (lines[i + 1]?.at ?? end));
  if (idx < 0) return null;
  const line = lines[idx];
  const until = lines[idx + 1]?.at ?? end;
  const opacity = Math.min(ramp(frame, line.at, line.at + 6), ramp(frame, until - 6, until, [1, 0]));
  return (
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 54, display: 'flex', justifyContent: 'center', opacity}}>
      <div
        style={{
          maxWidth: 1600,
          padding: '12px 28px',
          borderRadius: 14,
          background: 'rgba(12, 13, 15, 0.78)',
          border: `1px solid ${COLORS.border}`,
          fontFamily: FONT.sans,
          fontSize: 40,
          fontWeight: 600,
          color: COLORS.text,
          letterSpacing: 0.5,
          textAlign: 'center',
          lineHeight: 1.35,
        }}
      >
        {line.zh}
      </div>
    </div>
  );
};
