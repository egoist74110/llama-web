import React from 'react';
import {AbsoluteFill} from 'remotion';
import {VIDEO} from '../theme';

// Full-frame SVG layer in frame pixel coordinates. Put wires and packets in here,
// and render it *before* cards so cards sit on top of wire ends.
export const Stage: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => (
  <AbsoluteFill style={{pointerEvents: 'none', ...style}}>
    <svg width={VIDEO.width} height={VIDEO.height} viewBox={`0 0 ${VIDEO.width} ${VIDEO.height}`}>
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {children}
    </svg>
  </AbsoluteFill>
);
