import React from 'react';
import {useCurrentFrame} from 'remotion';
import {pointAt, trimPath} from '../lib/geometry';
import {COLORS} from '../theme';

type Props = {
  d: string;
  // Draw-on progress 0..1 (the path grows from its start).
  draw?: number;
  color?: string;
  width?: number;
  opacity?: number;
  // Marching dashes along the path. 0 = solid line.
  dash?: number;
  // Dash speed in px per frame; negative runs backwards. Only used when dash > 0.
  speed?: number;
  // Glowing dots travelling along the path (data flow).
  dots?: number;
  dotColor?: string;
  // Frames for one dot to traverse the whole path.
  dotPeriod?: number;
  // Fade dots in (0..1), so they can start after the line is drawn.
  dotOpacity?: number;
  // Offset (frames) so dots on sibling lines are not in sync.
  phase?: number;
};

// A wire inside a <Stage>. Covers static wires, draw-on, flowing dashes and moving light dots.
export const FlowLine: React.FC<Props> = ({
  d,
  draw = 1,
  color = COLORS.flow,
  width = 2,
  opacity = 1,
  dash = 0,
  speed = 1.2,
  dots = 0,
  dotColor = COLORS.flow,
  dotPeriod = 60,
  dotOpacity = 1,
  phase = 0,
}) => {
  const frame = useCurrentFrame();
  const visible = trimPath(d, draw);
  if (!visible || opacity <= 0) return null;

  const dotEls: React.ReactNode[] = [];
  if (dots > 0 && draw >= 1 && dotOpacity > 0) {
    for (let i = 0; i < dots; i++) {
      const t = (((frame + phase) / dotPeriod + i / dots) % 1 + 1) % 1;
      const p = pointAt(d, t);
      // Fade at both ends so dots do not pop in/out at the anchors.
      const edge = Math.min(1, t / 0.08, (1 - t) / 0.08);
      dotEls.push(
        <circle key={i} cx={p.x} cy={p.y} r={4} fill={dotColor} opacity={dotOpacity * edge} filter="url(#glow)" />,
      );
    }
  }

  return (
    <g opacity={opacity}>
      <path
        d={visible}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dash > 0 ? `${dash} ${dash * 0.9}` : undefined}
        strokeDashoffset={dash > 0 ? -frame * speed : undefined}
      />
      {dotEls}
    </g>
  );
};
