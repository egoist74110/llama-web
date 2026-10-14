import React from 'react';
import {AbsoluteFill} from 'remotion';
import {AppShell} from '../ui/AppShell';
import {Camera, FULL, Shot} from '../ui/Camera';
import {SetupPage, SETUP_LAYOUT} from '../pages/SetupPage';
import {ModelsPage, MODELS_LAYOUT} from '../pages/ModelsPage';
import {FirstStartDialog, FIRST_START_LAYOUT} from '../pages/FirstStartDialog';
import {ModelEditorDrawer, MODEL_EDITOR_LAYOUT, MODEL_PROFILES_LAYOUT} from '../pages/ModelEditorDrawer';
import {OverviewPage, OVERVIEW_LAYOUT} from '../pages/OverviewPage';
import {SettingsRuntimePage, SETTINGS_LAYOUT} from '../pages/SettingsRuntimePage';
import {RuntimeAddModal, RUNTIME_ADD_LAYOUT} from '../pages/RuntimeAddModal';
import {VulkanConfirmModal, VULKAN_CONFIRM_LAYOUT} from '../pages/VulkanConfirmModal';
import {ConnectionsPage, CONNECTIONS_LAYOUT} from '../pages/ConnectionsPage';
import {UpstreamEditorDrawer, UPSTREAM_EDITOR_LAYOUT} from '../pages/UpstreamEditorDrawer';
import {LogsPage, LOGS_LAYOUT} from '../pages/LogsPage';

// Static page previews with click targets marked in red. For layout checks only (Studio folder "Pages").

export const DRAWER_SHOT: Shot = {zoom: 1.38, x: 1160, y: 310};

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

export const SetupPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="guide"
        showGuide
        overlay={
          <>
            {[
              SETUP_LAYOUT.pickFolder,
              SETUP_LAYOUT.addAndScan,
              SETUP_LAYOUT.downloadBtn,
              SETUP_LAYOUT.enableBtn,
              SETUP_LAYOUT.modeLocal,
              SETUP_LAYOUT.modeGateway,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <SetupPage
          mode="local"
          local={{
            dir: {added: 'X:\\models', typed: null, focused: false, found: 4},
            runtime: {status: 'busy', line: '正在下载 b11146（62%）'},
            enable: {done: null},
          }}
        />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const ModelsPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="models"
        counts={{models: 1}}
        overlay={
          <>
            {[
              MODELS_LAYOUT.tabEnabled,
              MODELS_LAYOUT.tabDiscover,
              MODELS_LAYOUT.enableBtn,
              MODELS_LAYOUT.startBtn,
              MODELS_LAYOUT.editBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <ModelsPage tab="discover" />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const FirstStartPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="models"
        counts={{models: 1}}
        overlay={
          <>
            <FirstStartDialog open enter={1} modelName="Qwen3-8B" />
            <Dot x={FIRST_START_LAYOUT.confirmBtn.x} y={FIRST_START_LAYOUT.confirmBtn.y} />
            <Dot x={FIRST_START_LAYOUT.cancelBtn.x} y={FIRST_START_LAYOUT.cancelBtn.y} />
          </>
        }
      >
        <ModelsPage tab="enabled" qwenEnabled />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const EditorPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={DRAWER_SHOT}>
      <AppShell
        active="models"
        counts={{models: 1}}
        overlay={
          <>
            <ModelEditorDrawer
              open
              enter={1}
              modelName="Qwen3-8B"
              tab="params"
              contextMode="custom"
              contextValue={32768}
              tier="fit"
              extraArgsString="--jinja"
            />
            {[
              MODEL_EDITOR_LAYOUT.contextModeSelect,
              MODEL_EDITOR_LAYOUT.contextInput,
              MODEL_EDITOR_LAYOUT.extraArgsInput,
              MODEL_EDITOR_LAYOUT.saveBtn,
              MODEL_EDITOR_LAYOUT.copyBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <ModelsPage tab="enabled" qwenEnabled />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const ProfilesPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={DRAWER_SHOT}>
      <AppShell
        active="models"
        counts={{models: 1}}
        overlay={
          <>
            <ModelEditorDrawer
              open
              enter={1}
              modelName="Qwen3-8B"
              tab="profiles"
            />
            {[
              MODEL_PROFILES_LAYOUT.cardDefault,
              MODEL_PROFILES_LAYOUT.cardLongCtx,
              MODEL_PROFILES_LAYOUT.cardNoThinking,
              MODEL_PROFILES_LAYOUT.setCurrentBtn,
              MODEL_PROFILES_LAYOUT.createBtn,
              MODEL_PROFILES_LAYOUT.duplicateBtn,
              MODEL_PROFILES_LAYOUT.renameBtn,
              MODEL_PROFILES_LAYOUT.removeBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <ModelsPage tab="enabled" qwenEnabled />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const OverviewPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="overview"
        counts={{models: 2}}
        serving={{
          state: 'ready',
          model: 'Qwen3-8B',
          tps: '42.7',
          generating: true,
        }}
        overlay={
          <>
            {[
              OVERVIEW_LAYOUT.heroCard,
              OVERVIEW_LAYOUT.speedNumber,
              OVERVIEW_LAYOUT.speedCurve,
              OVERVIEW_LAYOUT.requestsTile,
              OVERVIEW_LAYOUT.queuedStat,
              OVERVIEW_LAYOUT.recentEventsCard,
              OVERVIEW_LAYOUT.firstEvent,
              OVERVIEW_LAYOUT.apiBubble,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <OverviewPage
          hero={{
            state: 'ready',
            name: 'Qwen3-8B',
            file: 'X:\\models\\Qwen3-8B-Q4_K_M.gguf',
            profile: '长上下文',
            ctx: 131072,
            quant: 'Q4_K_M',
            vision: true,
            uptime: '已运行 3 分钟',
            inflight: 1,
            speedTps: '42.7',
            promptTps: '812',
            curveProgress: 1,
          }}
          requests={{
            inflight: 1,
            queued: 0,
            queuedModels: '',
          }}
        />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const SettingsPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="settings"
        counts={{models: 1}}
        overlay={
          <>
            {[
              SETTINGS_LAYOUT.addVersionBtn,
              SETTINGS_LAYOUT.currentChip,
              SETTINGS_LAYOUT.updateNotice,
              SETTINGS_LAYOUT.updateDownloadBtn,
              SETTINGS_LAYOUT.rollbackBtn,
              SETTINGS_LAYOUT.customBranchRow,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <SettingsRuntimePage hasCustomBranch />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const VulkanConfirmPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="settings"
        counts={{models: 1}}
        overlay={
          <>
            <VulkanConfirmModal open enter={1} />
            {[
              SETTINGS_LAYOUT.choicePromptCpuBtn,
              SETTINGS_LAYOUT.choicePromptVulkanBtn,
              VULKAN_CONFIRM_LAYOUT.confirmBtn,
              VULKAN_CONFIRM_LAYOUT.cancelBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <SettingsRuntimePage showChoicePrompt />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const RuntimeAddPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="settings"
        counts={{models: 1}}
        overlay={
          <>
            <RuntimeAddModal open enter={1} step="preview" />
            {[
              RUNTIME_ADD_LAYOUT.labelInput,
              RUNTIME_ADD_LAYOUT.addBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <SettingsRuntimePage />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const ConnectionsPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="connections"
        counts={{models: 1, connections: 2}}
        overlay={
          <>
            {[
              CONNECTIONS_LAYOUT.addServiceBtn,
              CONNECTIONS_LAYOUT.strataStartBtn,
              CONNECTIONS_LAYOUT.strataExclusiveSwitch,
              CONNECTIONS_LAYOUT.strataTestBtn,
              CONNECTIONS_LAYOUT.strataEditBtn,
              CONNECTIONS_LAYOUT.ninferTestBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <ConnectionsPage
          strataState="offline"
          strataExclusive
          showStrataModels
        />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const UpstreamEditorPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="connections"
        counts={{models: 1, connections: 2}}
        overlay={
          <>
            <UpstreamEditorDrawer
              open
              enter={1}
              name="Strata"
              baseUrl="http://127.0.0.1:8080/v1"
              apiKeyMasked
              startCommand='/bin/zsh "/Users/me/strata/start.sh"'
              guideOpen
              tested
            />
            {[
              UPSTREAM_EDITOR_LAYOUT.nameInput,
              UPSTREAM_EDITOR_LAYOUT.urlInput,
              UPSTREAM_EDITOR_LAYOUT.startCommandInput,
              UPSTREAM_EDITOR_LAYOUT.testBtn,
              UPSTREAM_EDITOR_LAYOUT.guideSummary,
              UPSTREAM_EDITOR_LAYOUT.copyPromptBtn,
              UPSTREAM_EDITOR_LAYOUT.saveBtn,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <ConnectionsPage strataState="offline" />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);

export const LogsPreview: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Camera shot={FULL}>
      <AppShell
        active="logs"
        counts={{models: 1, connections: 2}}
        overlay={
          <>
            {[
              LOGS_LAYOUT.requestsTab,
              LOGS_LAYOUT.noContentNote,
              LOGS_LAYOUT.strataRow,
              LOGS_LAYOUT.ttsRow,
            ].map((p, i) => (
              <Dot key={i} x={p.x} y={p.y} />
            ))}
          </>
        }
      >
        <LogsPage />
      </AppShell>
    </Camera>
  </AbsoluteFill>
);


