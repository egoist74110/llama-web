import React from 'react';
import {COLORS, RADIUS, SHADOW} from '../theme';

type Props = {
  // Center position and size in frame pixels.
  cx: number;
  cy: number;
  w: number;
  h: number;
  scale?: number;
  rotate?: number; // degrees
  opacity?: number;
  // Accent border + glow (llama-web itself, the active item).
  highlight?: boolean;
  raised?: boolean;
  padding?: number | string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

// The one card style: rounded 14px, thin border, soft shadow. Positioned by its center so
// layouts and wire anchors share the same coordinates. Content is clipped, never overflows.
export const Card: React.FC<Props> = ({
  cx,
  cy,
  w,
  h,
  scale = 1,
  rotate = 0,
  opacity = 1,
  highlight = false,
  raised = false,
  padding = 20,
  style,
  children,
}) => (
  <div
    style={{
      position: 'absolute',
      left: cx - w / 2,
      top: cy - h / 2,
      width: w,
      height: h,
      boxSizing: 'border-box',
      padding,
      borderRadius: RADIUS.card,
      background: raised ? COLORS.surfaceRaised : COLORS.surface,
      border: `1px solid ${highlight ? COLORS.accentLine : COLORS.border}`,
      boxShadow: highlight ? `${SHADOW.raised}, ${SHADOW.accentGlow}` : raised ? SHADOW.raised : SHADOW.card,
      transform: `scale(${scale}) rotate(${rotate}deg)`,
      opacity,
      overflow: 'hidden',
      ...style,
    }}
  >
    {children}
  </div>
);

// Single-line text that never overflows its container.
export const Line: React.FC<{style?: React.CSSProperties; children: React.ReactNode}> = ({style, children}) => (
  <div style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style}}>{children}</div>
);
