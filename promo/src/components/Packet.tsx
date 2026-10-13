import React from 'react';
import {pointAt} from '../lib/geometry';
import {COLORS, FONT, RADIUS, TYPE} from '../theme';

type Props = {
  // Route the packet travels along (frame pixels).
  d: string;
  // Position along the route, 0..1. Drive it with `ramp` or a spring.
  t: number;
  label?: string;
  color?: string;
  opacity?: number;
  scale?: number;
};

// A request / response packet: glowing dot with an optional pill label, positioned on a path.
// Render it in a plain HTML layer (not inside <Stage>), after the wires.
export const Packet: React.FC<Props> = ({d, t, label, color = COLORS.flow, opacity = 1, scale = 1}) => {
  const p = pointAt(d, t);
  return (
    <div
      style={{
        position: 'absolute',
        left: p.x,
        top: p.y,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: label ? '8px 14px 8px 10px' : 0,
        borderRadius: RADIUS.pill,
        background: label ? 'rgba(20, 21, 26, 0.92)' : 'transparent',
        border: label ? `1px solid ${color}` : 'none',
        boxShadow: `0 0 24px ${COLORS.flowSoft}`,
        whiteSpace: 'nowrap',
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: RADIUS.pill,
          background: color,
          boxShadow: `0 0 14px ${color}`,
        }}
      />
      {label ? (
        <span style={{fontFamily: FONT.mono, fontSize: TYPE.tiny, color: COLORS.text}}>{label}</span>
      ) : null}
    </div>
  );
};
