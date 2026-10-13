import React from 'react';
import {AbsoluteFill} from 'remotion';
import {COLORS} from '../theme';

// Flat gray background with a faint dot grid and a soft accent glow. Identical in every scene,
// so cuts between scenes never flash.
export const Background: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: COLORS.bg}}>
    <AbsoluteFill
      style={{
        backgroundImage: 'radial-gradient(rgba(255,255,255,0.045) 1.2px, transparent 1.2px)',
        backgroundSize: '32px 32px',
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 60% 55% at 50% 42%, ${COLORS.bgGlow}, transparent 70%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background: 'radial-gradient(ellipse 85% 85% at 50% 50%, transparent 60%, rgba(0,0,0,0.28) 100%)',
      }}
    />
  </AbsoluteFill>
);
