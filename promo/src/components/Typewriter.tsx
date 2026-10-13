import React from 'react';
import {useCurrentFrame} from 'remotion';
import {caretOn, typedCount} from '../lib/anim';
import {COLORS} from '../theme';

type Props = {
  text: string;
  // Local frame where typing starts.
  start: number;
  framesPerChar?: number;
  // Show a blinking caret while typing and `caretHold` frames after.
  caret?: boolean;
  caretHold?: number;
  style?: React.CSSProperties;
};

// Reveals `text` one character every `framesPerChar` frames. Purely frame-driven.
export const Typewriter: React.FC<Props> = ({text, start, framesPerChar = 2, caret = true, caretHold = 20, style}) => {
  const frame = useCurrentFrame();
  const n = typedCount(frame, start, text.length, framesPerChar);
  const doneAt = start + text.length * framesPerChar;
  const showCaret = caret && frame >= start && frame < doneAt + caretHold && (frame < doneAt || caretOn(frame));

  return (
    <span style={{whiteSpace: 'pre', ...style}}>
      {text.slice(0, n)}
      <span
        style={{
          display: 'inline-block',
          width: '0.08em',
          minWidth: 2,
          height: '1.1em',
          marginLeft: 2,
          verticalAlign: 'text-bottom',
          background: COLORS.accentText,
          opacity: showCaret ? 1 : 0,
        }}
      />
    </span>
  );
};

// Frame at which a Typewriter with these settings finishes. Use it to chain beats.
export const typeEnd = (text: string, start: number, framesPerChar = 2): number => start + text.length * framesPerChar;
