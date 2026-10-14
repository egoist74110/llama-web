import React from 'react';
import {Composition, Folder} from 'remotion';
import {PromoV2, PROMO_V2_FRAMES} from './PromoV2';
import {PainChapter} from './chapters/C0Pain';
import {BrandChapter} from './chapters/C1Brand';
import {SetupChapter} from './chapters/C2Setup';
import {ModelsChapter} from './chapters/C3Models';
import {ProfilesChapter} from './chapters/C4Profiles';
import {RuntimeChapter} from './chapters/C5Runtime';
import {ConnectionsChapter} from './chapters/C6Connections';
import {RequestChapter} from './chapters/C7Request';
import {PublicChapter} from './chapters/C8Public';
import {ClientChapter} from './chapters/C9Client';
import {RoadmapChapter} from './chapters/C95Roadmap';
import {OutroChapter} from './chapters/C10Outro';
import {ConnectionsPreview, EditorPreview, FirstStartPreview, LogsPreview, ModelsPreview, OverviewPreview, ProfilesPreview, RuntimeAddPreview, SettingsPreview, SetupPreview, UpstreamEditorPreview, VulkanConfirmPreview} from './previews/PagePreviews';
import {PublicOverviewPreview, PublicWizardPreview} from './previews/PublicPreviews';
import {STORY} from './story';
import {loadProductFonts} from './fonts';
import {VIDEO} from './theme';

loadProductFonts();

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="LlamaWebPromoV2"
      component={PromoV2}
      durationInFrames={PROMO_V2_FRAMES}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    <Folder name="Chapters">
      <Composition id="Ch0-Pain" component={PainChapter} durationInFrames={STORY.c0Pain.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch1-Brand" component={BrandChapter} durationInFrames={STORY.c1Brand.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch2-Setup" component={SetupChapter} durationInFrames={STORY.c2Setup.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch3-Models" component={ModelsChapter} durationInFrames={STORY.c3Models.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch4-Profiles" component={ProfilesChapter} durationInFrames={STORY.c4Profiles.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch5-Runtime" component={RuntimeChapter} durationInFrames={STORY.c5Runtime.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch6-Connections" component={ConnectionsChapter} durationInFrames={STORY.c6Connections.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch7-Request" component={RequestChapter} durationInFrames={STORY.c7Request.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch8-Public" component={PublicChapter} durationInFrames={STORY.c8Public.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch9-Client" component={ClientChapter} durationInFrames={STORY.c9Client.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch95-Roadmap" component={RoadmapChapter} durationInFrames={STORY.c95Roadmap.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Ch10-Outro" component={OutroChapter} durationInFrames={STORY.c10Outro.durationInFrames} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
    </Folder>
    <Folder name="Pages">
      <Composition id="Page-Setup" component={SetupPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Models" component={ModelsPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-FirstStart" component={FirstStartPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Editor" component={EditorPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Profiles" component={ProfilesPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Overview" component={OverviewPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Settings" component={SettingsPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-RuntimeAdd" component={RuntimeAddPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-VulkanConfirm" component={VulkanConfirmPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Connections" component={ConnectionsPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-UpstreamEditor" component={UpstreamEditorPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-Logs" component={LogsPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-PublicWizard" component={PublicWizardPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
      <Composition id="Page-PublicOverview" component={PublicOverviewPreview} durationInFrames={1} fps={VIDEO.fps} width={VIDEO.width} height={VIDEO.height} />
    </Folder>
  </>
);
