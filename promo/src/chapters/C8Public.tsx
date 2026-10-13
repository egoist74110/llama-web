import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Cursor} from '../components/Controls';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {mixPt, rippleAt, track} from '../lib/track';
import {PublicOverviewCard, PUBLIC_OVERVIEW_LAYOUT} from '../pages/PublicOverviewCard';
import {PublicWizard, PUBLIC_WIZARD_LAYOUT} from '../pages/PublicWizard';
import {cue, STORY} from '../story';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, project, Shot} from '../ui/Camera';

// Chapter 8: public access (公网访问). Beats are relative to narration cues.

const C = STORY.c8Public;

const c8_1 = cue('c8Public', 'c8-1');
const c8_2 = cue('c8Public', 'c8-2');
const c8_3 = cue('c8Public', 'c8-3');

const B = {
  // c8-1: choose "一键完成" and watch the run
  hoverApi: c8_1 + 6,
  clickApi: c8_1 + 22,
  clickNext: c8_1 + 44,
  run0: c8_1 + 50, // tunnel running
  run1: c8_1 + 62, // tunnel done
  run2: c8_1 + 74, // ingress done
  run3: c8_1 + 86, // dns done
  connected: c8_1 + 108,

  // c8-2: overview card
  overview: c8_2 - 2,
  addrFocus: c8_2 + 4,
  chip: c8_2 + 10,
  key1: c8_2 + 36,
  key2: c8_2 + 46,
  keyPhone: c8_2 + 40,
  keyServer: c8_2 + 56,

  // c8-3: back to the wizard options
  wizardBack: c8_3 - 2,
  hoverQuick: c8_3 + 8,
} as const;

const SHOTS: readonly {at: number; v: Shot}[] = [
  {at: 0, v: {zoom: 1.0, x: 720, y: 405}},
  {at: c8_1 - 4, v: {zoom: 1.28, x: 940, y: 420}},
  {at: B.overview, v: {zoom: 1.3, x: 940, y: 440}},
  {at: B.wizardBack, v: {zoom: 1.3, x: 1000, y: 420}},
];

const CLICKS = [B.clickApi, B.clickNext] as const;

const CURSOR = [
  {at: 0, v: {x: 1250, y: 640}},
  {at: B.hoverApi, v: PUBLIC_WIZARD_LAYOUT.optApi},
  {at: B.clickApi, v: PUBLIC_WIZARD_LAYOUT.optApi},
  {at: B.clickNext - 4, v: PUBLIC_WIZARD_LAYOUT.nextBtn},
  {at: B.clickNext, v: PUBLIC_WIZARD_LAYOUT.nextBtn},
  {at: B.run3, v: {x: 1100, y: 560}},
  // c8-2
  {at: B.addrFocus, v: PUBLIC_OVERVIEW_LAYOUT.addressUrl},
  {at: B.keyPhone, v: PUBLIC_OVERVIEW_LAYOUT.keyPhone},
  {at: B.keyServer, v: PUBLIC_OVERVIEW_LAYOUT.keyServer},
  // c8-3
  {at: B.wizardBack, v: {x: 1100, y: 560}},
  {at: B.hoverQuick, v: PUBLIC_WIZARD_LAYOUT.optQuick},
] as const;

export const PublicChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');
  const cursorApp = track(frame, fps, CURSOR, mixPt, 'snappy');
  const cursor = project(shot, cursorApp);

  const isClicking = (at: number) => frame >= at && frame < at + 6;

  const inOverview = frame >= B.overview && frame < B.wizardBack;
  const afterClickNext = frame >= B.clickNext + 4;

  const runningStep = frame >= B.run3 ? 3 : frame >= B.run2 ? 2 : frame >= B.run1 ? 1 : 0;
  const phase = frame >= B.connected ? 'connected' : afterClickNext ? 'running' : 'select';

  const inWizardOptions = frame >= B.wizardBack;
  const selectedOption = inWizardOptions ? null : frame >= B.clickApi ? 'api' : null;
  const hoverOption = inWizardOptions
    ? frame >= B.hoverQuick
      ? 'quick'
      : null
    : frame >= B.hoverApi && frame < B.clickApi
      ? 'api'
      : null;

  const highlightAddress = ramp(frame, B.addrFocus, B.addrFocus + 10);
  const keysShown = ramp(frame, B.key1, B.key1 + 8) + ramp(frame, B.key2, B.key2 + 8);

  return (
    <AbsoluteFill>
      <Background />

      <Camera shot={shot}>
        <AppShell active="settings" counts={{models: 1}}>
          {inOverview ? (
            <PublicOverviewCard
              highlightAddress={highlightAddress}
              showV1Chip={frame >= B.chip}
              keysShown={keysShown}
            />
          ) : (
            <PublicWizard
              phase={inWizardOptions ? 'select' : phase}
              selectedOption={selectedOption}
              hoverOption={hoverOption}
              runningStep={runningStep}
              spinDeg={frame * 12}
              apiCardPressed={isClicking(B.clickApi) ? 1 : 0}
              nextBtnPressed={isClicking(B.clickNext) ? 1 : 0}
            />
          )}
        </AppShell>
      </Camera>

      <Cursor x={cursor.x} y={cursor.y} press={rippleAt(frame, CLICKS)} />

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c8Public" />
    </AbsoluteFill>
  );
};
