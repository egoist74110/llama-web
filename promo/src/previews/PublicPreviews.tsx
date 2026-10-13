import React from 'react';
import {AbsoluteFill} from 'remotion';
import {AppShell} from '../ui/AppShell';
import {Camera, FULL} from '../ui/Camera';
import {PublicWizard, PUBLIC_WIZARD_LAYOUT} from '../pages/PublicWizard';
import {PublicOverviewCard, PUBLIC_OVERVIEW_LAYOUT} from '../pages/PublicOverviewCard';

// Static previews with click targets marked in red (layout checks only).

const Dot: React.FC<{x: number; y: number}> = ({x, y}) => (
  <div
    style={{
      position: 'absolute',
      left: x - 6,
      top: y - 6,
      width: 12,
      height: 12,
      borderRadius: 99,
      background: 'red',
      zIndex: 9999,
      pointerEvents: 'none',
      boxShadow: '0 0 0 2px #fff',
    }}
  />
);

export const PublicWizardPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="settings"
        counts={{models: 1}}
        overlay={
          <>
            {[
              PUBLIC_WIZARD_LAYOUT.optApi,
              PUBLIC_WIZARD_LAYOUT.optManual,
              PUBLIC_WIZARD_LAYOUT.optQuick,
              PUBLIC_WIZARD_LAYOUT.nextBtn,
              PUBLIC_WIZARD_LAYOUT.statusConnected,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <PublicWizard phase="select" selectedOption="api" />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const PublicOverviewPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="settings"
        counts={{models: 1}}
        overlay={
          <>
            {[
              PUBLIC_OVERVIEW_LAYOUT.addressUrl,
              PUBLIC_OVERVIEW_LAYOUT.copyAddressBtn,
              PUBLIC_OVERVIEW_LAYOUT.keyPhone,
              PUBLIC_OVERVIEW_LAYOUT.keyServer,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <PublicOverviewCard highlightAddress={1} />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);
