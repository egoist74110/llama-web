import React from 'react';
import {AbsoluteFill} from 'remotion';
import {lerp} from '../lib/anim';
import {VIDEO} from '../theme';
import {APP_H, APP_W} from './AppShell';

// Frames the native-size app (APP_W x APP_H) in the 1920x1080 video.
// zoom 1 = the app exactly fills the frame. zoom > 1 pushes in on `focus` (native app px).
// zoom < 1 shows the app as a floating window with rounded corners on the background.

export type Shot = {zoom: number; x: number; y: number};

export const FULL: Shot = {zoom: 1, x: APP_W / 2, y: APP_H / 2};

// Interpolate between two shots (t 0..1, already eased by the caller, e.g. a spring).
export const mixShot = (a: Shot, b: Shot, t: number): Shot => ({
  zoom: lerp(a.zoom, b.zoom, t),
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

const BASE = VIDEO.width / APP_W; // 1.3333: app width fills the frame

export const Camera: React.FC<{shot: Shot; children: React.ReactNode}> = ({shot, children}) => {
  const s = BASE * shot.zoom;
  const w = APP_W * s;
  const h = APP_H * s;
  let tx = VIDEO.width / 2 - shot.x * s;
  let ty = VIDEO.height / 2 - shot.y * s;
  // Never show past the app's edges once it is larger than the frame.
  if (w >= VIDEO.width) tx = Math.min(0, Math.max(VIDEO.width - w, tx));
  else tx = (VIDEO.width - w) / 2;
  if (h >= VIDEO.height) ty = Math.min(0, Math.max(VIDEO.height - h, ty));
  else ty = (VIDEO.height - h) / 2;
  const windowed = shot.zoom < 0.999;

  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: APP_W,
          height: APP_H,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${s})`,
          borderRadius: windowed ? 12 : 0,
          overflow: 'hidden',
          boxShadow: windowed ? '0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)' : 'none',
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

// Map a native app point to frame pixels for a given shot (same math as <Camera>).
export const project = (shot: Shot, p: {x: number; y: number}): {x: number; y: number} => {
  const s = BASE * shot.zoom;
  const w = APP_W * s;
  const h = APP_H * s;
  let tx = VIDEO.width / 2 - shot.x * s;
  let ty = VIDEO.height / 2 - shot.y * s;
  if (w >= VIDEO.width) tx = Math.min(0, Math.max(VIDEO.width - w, tx));
  else tx = (VIDEO.width - w) / 2;
  if (h >= VIDEO.height) ty = Math.min(0, Math.max(VIDEO.height - h, ty));
  else ty = (VIDEO.height - h) / 2;
  return {x: tx + p.x * s, y: ty + p.y * s};
};
