import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../components/Background';
import {Captions} from '../components/Captions';
import {Cursor} from '../components/Controls';
import {Voice} from '../components/Voice';
import {ramp} from '../lib/anim';
import {mixPt, rippleAt, track} from '../lib/track';
import {ModelEditorDrawer, MODEL_EDITOR_LAYOUT} from '../pages/ModelEditorDrawer';
import {ModelsPage} from '../pages/ModelsPage';
import {RuntimeAddModal, RUNTIME_ADD_LAYOUT} from '../pages/RuntimeAddModal';
import {SettingsRuntimePage, SETTINGS_LAYOUT} from '../pages/SettingsRuntimePage';
import {VulkanConfirmModal, VULKAN_CONFIRM_LAYOUT} from '../pages/VulkanConfirmModal';
import {cue, STORY} from '../story';
import {AppShell} from '../ui/AppShell';
import {Camera, mixShot, project, Shot} from '../ui/Camera';
import {Toast} from '../ui/lw';

// Chapter 5 — llama.cpp Version & Variants (llama.cpp 版本与变体)
// Beats are relative to narration cues.
// Pure declarative rendering driven by useCurrentFrame.

const C = STORY.c5Runtime;

const c5_1 = cue('c5Runtime', 'c5-1');
const c5_2 = cue('c5Runtime', 'c5-2');
const c5_3 = cue('c5Runtime', 'c5-3');
const c5_4 = cue('c5Runtime', 'c5-4');

const URL_TEXT = 'https://github.com/example/llama.cpp-fork';
const LABEL_TEXT = '我的分支';

// Keyframe beats
const B = {
  // c5-1: Highlighting versions on Settings page
  focusCurrent: c5_1 + 10,
  focusAvailable: c5_1 + 48,
  focusRollback: c5_1 + 86,

  // c5-2: Adding custom version
  moveAddBtn: c5_2 + 2,
  clickAddBtn: c5_2 + 8,
  modalOpen: c5_2 + 10,
  clickTabGithub: c5_2 + 22,
  focusUrl: c5_2 + 26,
  typeUrlStart: c5_2 + 28,
  typeUrlEnd: c5_2 + 54,
  movePreviewBtn: c5_2 + 58,
  clickPreviewBtn: c5_2 + 62,

  confirmStep: c5_2 + 64,
  moveConfirmRun: c5_2 + 70,
  clickConfirmRun: c5_2 + 76,

  previewStep: c5_2 + 80,
  focusLabel: c5_2 + 86,
  typeLabelStart: c5_2 + 90,
  typeLabelEnd: c5_2 + 104,
  moveAddConfirm: c5_2 + 108,
  clickAddConfirm: c5_2 + 114,

  modalClose: c5_2 + 118,
  versionAdded: c5_2 + 120,
  viewNewRow: c5_2 + 126,

  // c5-3: Model Editor Drawer
  drawerOpen: c5_3,
  moveRuntimeSelect: c5_3 + 8,
  clickRuntimeSelect: c5_3 + 16,
  previewSettled: c5_3 + 28,

  // c5-4: Vulkan choice & confirmation
  switchSettingsBack: c5_4 - 4,
  focusChoicePrompt: c5_4 + 10,
  moveVulkanChoice: c5_4 + 20,
  clickVulkanChoice: c5_4 + 70,
  vulkanModalOpen: c5_4 + 76,
  vulkanModalSettled: c5_4 + 86,
  moveVulkanConfirm: c5_4 + 100,
  clickVulkanConfirm: c5_4 + 140,
  vulkanModalClose: c5_4 + 146,
  vulkanModalClosed: c5_4 + 154,
  vulkanDownloadStart: c5_4 + 156,
  moveVulkanDownloading: c5_4 + 180,
} as const;

// Camera shots
const SHOTS: readonly {at: number; v: Shot}[] = [
  // Start: Framed nicely on the Settings page
  {at: 0, v: {zoom: 1.0, x: 720, y: 405}},

  // c5-1: Push in closely to the llama.cpp version card (framed safely above caption band)
  {at: c5_1 - 4, v: {zoom: 1.25, x: 940, y: 430}},

  // c5-2: Focus centered on the Add Version modal
  {at: B.clickAddBtn, v: {zoom: 1.22, x: 720, y: 405}},

  // When modal closes, push onto the updated version list
  {at: B.modalClose, v: {zoom: 1.28, x: 940, y: 430}},

  // c5-3: Transition cleanly to Model Editor Drawer (focus on runtime select & command preview above captions)
  {at: c5_3 - 6, v: {zoom: 1.20, x: 1140, y: 470}},

  // c5-4: Return to Settings page, push in closely on llama.cpp version card with choice banner & Vulkan channel
  {at: c5_4 - 4, v: {zoom: 1.24, x: 940, y: 440}},
];

// Click events for pressAt & ripple feedback
const CLICKS = [
  B.clickAddBtn,
  B.clickTabGithub,
  B.clickPreviewBtn,
  B.clickConfirmRun,
  B.clickAddConfirm,
  B.clickRuntimeSelect,
  B.clickVulkanChoice,
  B.clickVulkanConfirm,
] as const;

// Cursor track in native app coordinates (1440 x 810)
const CURSOR = [
  {at: 0, v: {x: 1200, y: 680}},
  // c5-1: Move to "当前" chip
  {at: B.focusCurrent, v: SETTINGS_LAYOUT.currentChip},
  // Move to "下载更新" / "发现新版"
  {at: B.focusAvailable, v: SETTINGS_LAYOUT.updateDownloadBtn},
  // Move to "回退到此版本"
  {at: B.focusRollback, v: SETTINGS_LAYOUT.rollbackBtn},

  // c5-2: Click "+ 添加版本"
  {at: B.clickAddBtn - 2, v: SETTINGS_LAYOUT.addVersionBtn},
  {at: B.clickAddBtn, v: SETTINGS_LAYOUT.addVersionBtn},

  // Click "GitHub 地址"
  {at: B.clickTabGithub - 2, v: RUNTIME_ADD_LAYOUT.tabGithub},
  {at: B.clickTabGithub, v: RUNTIME_ADD_LAYOUT.tabGithub},

  // Focus URL input
  {at: B.focusUrl, v: RUNTIME_ADD_LAYOUT.urlInput},
  {at: B.typeUrlEnd, v: RUNTIME_ADD_LAYOUT.urlInput},

  // Click "预览"
  {at: B.clickPreviewBtn - 2, v: RUNTIME_ADD_LAYOUT.previewBtn},
  {at: B.clickPreviewBtn, v: RUNTIME_ADD_LAYOUT.previewBtn},

  // Click "我明白，继续预览"
  {at: B.clickConfirmRun - 2, v: RUNTIME_ADD_LAYOUT.confirmRunBtn},
  {at: B.clickConfirmRun, v: RUNTIME_ADD_LAYOUT.confirmRunBtn},

  // Focus Label input
  {at: B.focusLabel, v: RUNTIME_ADD_LAYOUT.labelInput},
  {at: B.typeLabelEnd, v: RUNTIME_ADD_LAYOUT.labelInput},

  // Click "添加"
  {at: B.clickAddConfirm - 2, v: RUNTIME_ADD_LAYOUT.addBtn},
  {at: B.clickAddConfirm, v: RUNTIME_ADD_LAYOUT.addBtn},

  // Hover newly added row
  {at: B.viewNewRow, v: SETTINGS_LAYOUT.customBranchRow},

  // c5-3: Move to Model Editor Drawer runtime select
  {at: B.moveRuntimeSelect, v: {x: 1280, y: 320}},
  {at: B.clickRuntimeSelect, v: MODEL_EDITOR_LAYOUT.runtimeSelect},
  {at: B.previewSettled, v: {x: 1040, y: 640}},

  // c5-4: Move to "试用 Vulkan 版（实验性）" button
  {at: c5_4, v: {x: 1040, y: 640}},
  {at: B.clickVulkanChoice - 24, v: SETTINGS_LAYOUT.choicePromptVulkanBtn},
  {at: B.clickVulkanChoice + 10, v: SETTINGS_LAYOUT.choicePromptVulkanBtn},

  // Move to modal "下载 Vulkan 版"
  {at: B.clickVulkanConfirm - 20, v: VULKAN_CONFIRM_LAYOUT.confirmBtn},
  {at: B.clickVulkanConfirm + 8, v: VULKAN_CONFIRM_LAYOUT.confirmBtn},

  // Move to Vulkan downloading button
  {at: B.moveVulkanDownloading, v: SETTINGS_LAYOUT.vulkanDownloadBtn},
  {at: STORY.c5Runtime.durationInFrames, v: SETTINGS_LAYOUT.vulkanDownloadBtn},
] as const;

export const RuntimeChapter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Camera and cursor tracking
  const shot = track(frame, fps, SHOTS, mixShot, 'snappy');
  const cursorApp = track(frame, fps, CURSOR, mixPt, 'snappy');
  const cursor = project(shot, cursorApp);

  const isClicking = (at: number) => frame >= at && frame < at + 6;

  // c5-1 Highlights
  const highlightCurrent =
    frame >= B.focusCurrent && frame < B.focusAvailable
      ? Math.sin(ramp(frame, B.focusCurrent, B.focusAvailable) * Math.PI)
      : 0;

  const highlightAvailable =
    frame >= B.focusAvailable && frame < B.focusRollback
      ? Math.sin(ramp(frame, B.focusAvailable, B.focusRollback) * Math.PI)
      : 0;

  const highlightRollback =
    frame >= B.focusRollback && frame < B.clickAddBtn - 4
      ? Math.sin(ramp(frame, B.focusRollback, B.clickAddBtn - 4) * Math.PI)
      : 0;

  // c5-2 Modal State
  const modalOpen = frame >= B.modalOpen && frame < B.modalClose;
  const modalEnter =
    frame < B.modalOpen
      ? 0
      : frame < B.clickAddConfirm
        ? ramp(frame, B.modalOpen, B.modalOpen + 6)
        : 1 - ramp(frame, B.modalClose - 4, B.modalClose);

  const modalStep =
    frame < B.confirmStep
      ? 'source'
      : frame < B.previewStep
        ? 'confirm'
        : 'preview';

  // Typewriters
  const urlChars = Math.round(ramp(frame, B.typeUrlStart, B.typeUrlEnd) * URL_TEXT.length);
  const currentUrl = URL_TEXT.slice(0, urlChars);

  const labelChars = Math.round(ramp(frame, B.typeLabelStart, B.typeLabelEnd) * LABEL_TEXT.length);
  const currentLabel = LABEL_TEXT.slice(0, labelChars);

  // Version Added Status
  const hasCustomBranch = frame >= B.versionAdded;
  const toastEnter =
    frame >= B.versionAdded && frame < c5_3 - 4
      ? ramp(frame, B.versionAdded, B.versionAdded + 6) * (1 - ramp(frame, c5_3 - 12, c5_3 - 4))
      : 0;

  // c5-3 Drawer State
  const inDrawerPhase = frame >= c5_3 - 6 && frame < c5_4 - 4;
  const runtimeSelected = frame >= B.clickRuntimeSelect;

  // c5-4 State
  const showChoicePrompt = frame >= c5_4 - 4 && frame < B.vulkanModalClosed;
  const vulkanModalOpen = frame >= B.vulkanModalOpen && frame < B.vulkanModalClosed;
  const vulkanModalEnter =
    frame < B.vulkanModalOpen
      ? 0
      : frame < B.vulkanModalClose
        ? ramp(frame, B.vulkanModalOpen, B.vulkanModalSettled)
        : 1 - ramp(frame, B.vulkanModalClose, B.vulkanModalClosed);

  const showVulkanChannel = frame >= B.vulkanDownloadStart;

  return (
    <AbsoluteFill>
      <Background />

      <Camera shot={shot}>
        <AppShell
          active={inDrawerPhase ? 'models' : 'settings'}
          counts={{models: 1}}
          overlay={
            <>
              {/* Add Version Modal */}
              {modalOpen ? (
                <RuntimeAddModal
                  open
                  enter={modalEnter}
                  step={modalStep}
                  kind={frame >= B.clickTabGithub ? 'github' : 'dir'}
                  tabGithubPressed={isClicking(B.clickTabGithub) ? 1 : 0}
                  urlString={currentUrl}
                  previewBtnPressed={isClicking(B.clickPreviewBtn) ? 1 : 0}
                  confirmBtnPressed={isClicking(B.clickConfirmRun) ? 1 : 0}
                  labelString={currentLabel}
                  addBtnPressed={isClicking(B.clickAddConfirm) ? 1 : 0}
                />
              ) : null}

              {/* Toast when added */}
              <Toast title="已添加 我的分支" enter={toastEnter} />

              {/* Model Editor Drawer in c5-3 */}
              {inDrawerPhase ? (
                <ModelEditorDrawer
                  open
                  enter={1}
                  modelName="Qwen3-8B"
                  tab="params"
                  runtimeValue={runtimeSelected ? '我的分支' : '跟随上一层（b11146）'}
                  runtimeSelectPressed={isClicking(B.clickRuntimeSelect) ? 1 : 0}
                />
              ) : null}

              {/* Vulkan Download Confirm Modal in c5-4 */}
              {vulkanModalOpen ? (
                <VulkanConfirmModal
                  open
                  enter={vulkanModalEnter}
                  confirmPressed={isClicking(B.clickVulkanConfirm) ? 1 : 0}
                />
              ) : null}

            </>
          }
        >
          {inDrawerPhase ? (
            <ModelsPage tab="enabled" qwenEnabled qwenState="stopped" />
          ) : (
            <SettingsRuntimePage
              hasCustomBranch={hasCustomBranch}
              addVersionPressed={isClicking(B.clickAddBtn) ? 1 : 0}
              highlightCurrent={highlightCurrent}
              highlightAvailable={highlightAvailable}
              highlightRollback={highlightRollback}
              showChoicePrompt={showChoicePrompt}
              choicePromptVulkanPressed={isClicking(B.clickVulkanChoice) ? 1 : 0}
              showVulkanChannel={showVulkanChannel}
              vulkanDownloading={showVulkanChannel}
            />
          )}
        </AppShell>
      </Camera>

      {/* Render cursor on top in video coordinates */}
      <Cursor
        x={cursor.x}
        y={cursor.y}
        press={rippleAt(frame, CLICKS)}
      />

      <Captions lines={C.captions} end={C.durationInFrames} />
      <Voice chapter="c5Runtime" />
    </AbsoluteFill>
  );
};
