import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Cursor} from '../components/Controls';
import {TierChart} from '../components/TierChart';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {mixPt, rippleAt, track} from '../lib/track';
import {ConnectionsPage, CONNECTIONS_LAYOUT} from '../pages/ConnectionsPage';
import {UpstreamEditorDrawer, UPSTREAM_EDITOR_LAYOUT} from '../pages/UpstreamEditorDrawer';
import {cue, STORY} from '../story';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, project, Shot} from '../ui/Camera';
import {COLORS} from '../theme';
import {Toast} from '../ui/lw';

// Chapter 6 — Connect Other Engines: Limited Management (接入其他引擎：有限管理)
// Driven strictly by narration audio cues from narration.json & vo-manifest.json.

const C = STORY.c6Connections;

const c6_1 = cue('c6Connections', 'c6-1');
const c6_2 = cue('c6Connections', 'c6-2');
const c6_3 = cue('c6Connections', 'c6-3');
const c6_4 = cue('c6Connections', 'c6-4');

const NAME_STRATA = 'Strata';
const URL_STRATA = 'http://127.0.0.1:8080/v1';
const CMD_STRATA = '/bin/zsh "/Users/me/strata/start.sh"';

// Timeline beats
const B = {
  // c6-1: Open drawer, type credentials, test connection, save
  moveAddBtn: c6_1 + 2,
  clickAddBtn: c6_1 + 8,
  drawer1Open: c6_1 + 10,
  focusName: c6_1 + 18,
  typeNameStart: c6_1 + 20,
  typeNameEnd: c6_1 + 32,
  focusUrl: c6_1 + 36,
  typeUrlStart: c6_1 + 38,
  typeUrlEnd: c6_1 + 72,
  focusCmd: c6_1 + 76,
  typeCmdStart: c6_1 + 80,
  typeCmdEnd: c6_1 + 120,
  focusTest: c6_1 + 124,
  clickTest: c6_1 + 130,
  testedSettled: c6_1 + 134,
  focusSave: c6_1 + 168,
  clickSave: c6_1 + 174,
  drawer1Close: c6_1 + 178,
  drawer1Closed: c6_1 + 184,

  // c6-2: Start Strata -> waiting -> online + exclusive -> stop
  moveStartBtn: c6_2 + 4,
  clickStartBtn: c6_2 + 10,
  startingStart: c6_2 + 12,
  onlineTime: c6_2 + 48,
  moveStopBtn: c6_2 + 82,
  clickStopBtn: c6_2 + 88,
  stoppedTime: c6_2 + 92,

  // c6-3: Re-open drawer, expand AI tutorial, copy prompt
  moveEditBtn: c6_3 + 2,
  clickEditBtn: c6_3 + 6,
  drawer2Open: c6_3 + 8,
  moveGuideSummary: c6_3 + 16,
  clickGuideSummary: c6_3 + 22,
  guideExpanded: c6_3 + 26,
  moveCopyBtn: c6_3 + 46,
  clickCopyBtn: c6_3 + 52,
  copiedTime: c6_3 + 54,

  // c6-4: Close drawer, sweep over NInfer card, transition to TierChart
  drawer2Close: c6_4 - 2,
  drawer2Closed: c6_4 + 4,
  viewNInfer: c6_4 + 10,
  tierChartStart: c6_4 + 48,
  tierCol1: c6_4 + 54,
  tierCol2: c6_4 + 72,
  tierCol3: c6_4 + 90,
} as const;

// Camera shots
const SHOTS: readonly {at: number; v: Shot}[] = [
  // Start: Full page overview of connections
  {at: 0, v: {zoom: 1.0, x: 720, y: 405}},

  // c6-1: Push right to focus on the drawer input fields
  {at: B.clickAddBtn - 2, v: {zoom: 1.18, x: 1140, y: 430}},

  // When drawer 1 closes, center cleanly on Strata card
  {at: B.drawer1Close, v: {zoom: 1.16, x: 880, y: 380}},

  // c6-2: Focus firmly on Strata card and exclusive notice
  {at: c6_2 - 4, v: {zoom: 1.16, x: 880, y: 380}},

  // c6-3: Shift focus back to drawer right side
  {at: B.clickEditBtn - 2, v: {zoom: 1.18, x: 1140, y: 450}},

  // c6-4: Sweep camera down to NInfer card
  {at: c6_4 - 4, v: {zoom: 1.18, x: 880, y: 640}},

  // c6-4: Transition out to TierChart full view
  {at: B.tierChartStart - 2, v: {zoom: 1.0, x: 720, y: 395}},
];

// Click events for pressAt & ripple
const CLICKS = [
  B.clickAddBtn,
  B.clickTest,
  B.clickSave,
  B.clickStartBtn,
  B.clickStopBtn,
  B.clickEditBtn,
  B.clickGuideSummary,
  B.clickCopyBtn,
] as const;

// Cursor track in native app coordinates (1440 x 810)
const CURSOR = [
  {at: 0, v: {x: 1200, y: 680}},
  // Move to "+ 添加外部服务"
  {at: B.moveAddBtn, v: CONNECTIONS_LAYOUT.addServiceBtn},
  {at: B.clickAddBtn, v: CONNECTIONS_LAYOUT.addServiceBtn},

  // Focus Name input
  {at: B.focusName, v: UPSTREAM_EDITOR_LAYOUT.nameInput},
  {at: B.typeNameEnd, v: UPSTREAM_EDITOR_LAYOUT.nameInput},

  // Focus URL input
  {at: B.focusUrl, v: UPSTREAM_EDITOR_LAYOUT.urlInput},
  {at: B.typeUrlEnd, v: UPSTREAM_EDITOR_LAYOUT.urlInput},

  // Focus Command input
  {at: B.focusCmd, v: UPSTREAM_EDITOR_LAYOUT.startCommandInput},
  {at: B.typeCmdEnd, v: UPSTREAM_EDITOR_LAYOUT.startCommandInput},

  // Click "测试连接"
  {at: B.focusTest, v: UPSTREAM_EDITOR_LAYOUT.testBtn},
  {at: B.clickTest, v: UPSTREAM_EDITOR_LAYOUT.testBtn},

  // Hover tested model, then move to "保存"
  {at: B.testedSettled + 16, v: {x: 1040, y: 610}},
  {at: B.focusSave, v: UPSTREAM_EDITOR_LAYOUT.saveBtn},
  {at: B.clickSave, v: UPSTREAM_EDITOR_LAYOUT.saveBtn},

  // c6-2: Move to Strata "启动" button
  {at: B.moveStartBtn, v: CONNECTIONS_LAYOUT.strataStartBtn},
  {at: B.clickStartBtn, v: CONNECTIONS_LAYOUT.strataStartBtn},

  // Rest slightly while starting, then hover online status
  {at: B.onlineTime, v: {x: 880, y: 220}},
  {at: B.moveStopBtn, v: CONNECTIONS_LAYOUT.strataStopBtn},
  {at: B.clickStopBtn, v: CONNECTIONS_LAYOUT.strataStopBtn},

  // c6-3: Move to Strata "编辑" button
  {at: B.moveEditBtn, v: CONNECTIONS_LAYOUT.strataEditBtn},
  {at: B.clickEditBtn, v: CONNECTIONS_LAYOUT.strataEditBtn},

  // Click "不知道怎么写启动命令？"
  {at: B.moveGuideSummary, v: UPSTREAM_EDITOR_LAYOUT.guideSummary},
  {at: B.clickGuideSummary, v: UPSTREAM_EDITOR_LAYOUT.guideSummary},

  // Click "复制这段话" (scrolled up in drawer: y = 688)
  {at: B.moveCopyBtn, v: {x: 934, y: 688}},
  {at: B.clickCopyBtn, v: {x: 934, y: 688}},

  // c6-4: Move down towards NInfer card "测试连接"
  {at: B.viewNInfer, v: CONNECTIONS_LAYOUT.ninferTestBtn},
  {at: B.tierChartStart - 4, v: CONNECTIONS_LAYOUT.ninferTestBtn},
  {at: B.tierChartStart, v: {x: 1200, y: 720}},
] as const;

export const ConnectionsChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Camera & Cursor
  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');
  const cursorApp = track(frame, fps, CURSOR, mixPt, 'snappy');
  const cursor = project(shot, cursorApp);

  const isClicking = (at: number) => frame >= at && frame < at + 6;

  // c6-1 Drawer 1 State
  const inDrawer1 = frame >= B.drawer1Open && frame < B.drawer1Closed;
  const drawer1Enter =
    frame < B.drawer1Open
      ? 0
      : frame < B.drawer1Close
        ? ramp(frame, B.drawer1Open, B.drawer1Open + 6)
        : 1 - ramp(frame, B.drawer1Close, B.drawer1Closed);

  // Typewriters in c6-1
  const nameChars = Math.round(ramp(frame, B.typeNameStart, B.typeNameEnd) * NAME_STRATA.length);
  const currentName = NAME_STRATA.slice(0, nameChars);

  const urlChars = Math.round(ramp(frame, B.typeUrlStart, B.typeUrlEnd) * URL_STRATA.length);
  const currentUrl = URL_STRATA.slice(0, urlChars);

  const cmdChars = Math.round(ramp(frame, B.typeCmdStart, B.typeCmdEnd) * CMD_STRATA.length);
  const currentCmd = CMD_STRATA.slice(0, cmdChars);

  const isTestTested = frame >= B.clickTest;

  // c6-1 Toasts
  const toastTestedEnter =
    frame >= B.clickTest && frame < B.clickSave
      ? ramp(frame, B.clickTest, B.clickTest + 6) * (1 - ramp(frame, B.clickSave - 8, B.clickSave))
      : 0;

  const toastAddedEnter =
    frame >= B.drawer1Closed && frame < c6_2 + 20
      ? ramp(frame, B.drawer1Closed, B.drawer1Closed + 6) * (1 - ramp(frame, c6_2 + 12, c6_2 + 20))
      : 0;

  // c6-2 Strata card state
  const isStrataStarting = frame >= B.startingStart && frame < B.onlineTime;
  const isStrataOnline = frame >= B.onlineTime && frame < B.stoppedTime;
  const strataState = isStrataStarting ? 'starting' : isStrataOnline ? 'online' : 'offline';

  // Elapsed seconds count while starting (1..6)
  const waitedSec = Math.min(6, Math.max(1, Math.floor(1 + ramp(frame, B.startingStart, B.onlineTime - 2) * 5)));

  // Exclusive notice appears while Strata is online
  const showExclusiveNotice = isStrataOnline;

  const toastStoppedEnter =
    frame >= B.stoppedTime && frame < c6_3 - 4
      ? ramp(frame, B.stoppedTime, B.stoppedTime + 6) * (1 - ramp(frame, c6_3 - 12, c6_3 - 4))
      : 0;

  // c6-3 Drawer 2 State (Editing Strata)
  const inDrawer2 = frame >= B.drawer2Open && frame < B.drawer2Closed;
  const drawer2Enter =
    frame < B.drawer2Open
      ? 0
      : frame < B.drawer2Close
        ? ramp(frame, B.drawer2Open, B.drawer2Open + 6)
        : 1 - ramp(frame, B.drawer2Close, B.drawer2Closed);

  const isGuideOpen = frame >= B.clickGuideSummary;
  const isCopied = frame >= B.clickCopyBtn;
  const drawer2ScrollY = ramp(frame, B.clickGuideSummary + 4, B.clickGuideSummary + 16) * 270;

  const toastCopiedEnter =
    frame >= B.clickCopyBtn && frame < c6_4 - 4
      ? ramp(frame, B.clickCopyBtn, B.clickCopyBtn + 6) * (1 - ramp(frame, c6_4 - 12, c6_4 - 4))
      : 0;

  // c6-4 TierChart transition & column enters
  const showTierChart = frame >= B.tierChartStart;
  const tierProgress = ramp(frame, B.tierChartStart, B.tierChartStart + 10);
  const tierCol1Enter = ramp(frame, B.tierCol1, B.tierCol1 + 14);
  const tierCol2Enter = ramp(frame, B.tierCol2, B.tierCol2 + 14);
  const tierCol3Enter = ramp(frame, B.tierCol3, B.tierCol3 + 14);

  return (
    <AbsoluteFill>
      <Background />

      <Camera shot={shot}>
        <AppShell
          active="connections"
          counts={{models: 1, connections: 2}}
          overlay={
            <>
              {/* Drawer in c6-1: Adding Strata */}
              {inDrawer1 ? (
                <UpstreamEditorDrawer
                  open
                  enter={drawer1Enter}
                  title="添加外部服务"
                  name={currentName}
                  baseUrl={currentUrl}
                  apiKeyMasked={urlChars > 10}
                  startCommand={currentCmd}
                  tested={isTestTested}
                  testedModel="Strata-qwen3-32b"
                  nameInputPressed={frame >= B.typeNameStart && frame <= B.typeNameEnd ? 1 : 0}
                  urlInputPressed={frame >= B.typeUrlStart && frame <= B.typeUrlEnd ? 1 : 0}
                  startCommandPressed={frame >= B.typeCmdStart && frame <= B.typeCmdEnd ? 1 : 0}
                  testPressed={isClicking(B.clickTest) ? 1 : 0}
                  savePressed={isClicking(B.clickSave) ? 1 : 0}
                />
              ) : null}

              {/* Drawer in c6-3: Tutorial & AI prompt */}
              {inDrawer2 ? (
                <UpstreamEditorDrawer
                  open
                  enter={drawer2Enter}
                  title="编辑「Strata」"
                  name="Strata"
                  baseUrl="http://127.0.0.1:8080/v1"
                  apiKeyMasked
                  startCommand='/bin/zsh "/Users/me/strata/start.sh"'
                  tested
                  testedModel="Strata-qwen3-32b"
                  guideOpen={isGuideOpen}
                  copied={isCopied}
                  scrollY={drawer2ScrollY}
                  guideSummaryPressed={isClicking(B.clickGuideSummary) ? 1 : 0}
                  copyPressed={isClicking(B.clickCopyBtn) ? 1 : 0}
                />
              ) : null}

              {/* Toasts */}
              <Toast title="Strata: 连接正常，找到 1 个模型。" enter={toastTestedEnter} />
              <Toast title="已添加「Strata」" enter={toastAddedEnter} />
              <Toast title="「Strata」已关闭。" enter={toastStoppedEnter} />
              <Toast title="已复制" enter={toastCopiedEnter} />

              {/* c6-4: TierChart full scene transition */}
              {showTierChart ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: COLORS.bg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: tierProgress,
                    zIndex: 300,
                    paddingBottom: 40,
                  }}
                >
                  <TierChart
                    col1Enter={tierCol1Enter}
                    col2Enter={tierCol2Enter}
                    col3Enter={tierCol3Enter}
                  />
                </div>
              ) : null}
            </>
          }
        >
          <ConnectionsPage
            strataState={strataState}
            waitedSeconds={waitedSec}
            strataExclusive
            showStrataModels={frame >= B.testedSettled}
            exclusiveNotice={showExclusiveNotice}
            exclusiveHolder="Strata"
            addServicePressed={isClicking(B.clickAddBtn) ? 1 : 0}
            strataStartPressed={isClicking(B.clickStartBtn) ? 1 : 0}
            strataStopPressed={isClicking(B.clickStopBtn) ? 1 : 0}
            strataEditPressed={isClicking(B.clickEditBtn) ? 1 : 0}
          />
        </AppShell>
      </Camera>

      {/* Render cursor on top in video coordinates */}
      {!showTierChart ? (
        <Cursor
          x={cursor.x}
          y={cursor.y}
          press={rippleAt(frame, CLICKS)}
        />
      ) : null}

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c6Connections" />
    </AbsoluteFill>
  );
};
