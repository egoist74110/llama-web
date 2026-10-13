import React from 'react';
import {Img, staticFile} from 'remotion';
import {COLORS} from '../theme';

// The project icon (public/icon.png, 256x256). The only bitmap allowed in the video.
export const AppIcon: React.FC<{size: number; glow?: number}> = ({size, glow = 0}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.22,
      overflow: 'hidden',
      flexShrink: 0,
      border: `1px solid ${COLORS.borderStrong}`,
      boxShadow: glow > 0 ? `0 0 ${48 * glow}px rgba(109, 94, 252, ${0.45 * glow})` : 'none',
    }}
  >
    <Img src={staticFile('icon.png')} style={{width: '100%', height: '100%', display: 'block'}} />
  </div>
);
