# llama-web 宣传动画（第二版）

用 [Remotion](https://www.remotion.dev/)（React + TypeScript）制作的产品宣传动画第二版：1920×1080，30fps，整片时长约 2:55（5241 帧，12 个章节含 12 帧章节交叉淡化；有配音，无 BGM）。

全片绝大多数画面由代码 1:1 精确复刻 llama-web 真实产品界面（深色模式），除少量概念连线图外均为可交互状态的组件还原。

这是一个独立工程，有独立的 `package.json`，与主程序的依赖隔离。

---

## 快速开始

### 1. 安装

```bash
cd promo
npm install
```

需要 Node.js 18+。首次预览或渲染时，Remotion 会自动准备无头 Chrome 环境。

### 2. 预览

```bash
npx remotion studio
```

在打开的 Remotion Studio 界面中可查看：
- `LlamaWebPromoV2`：整片完整合成（含 12 帧章节间交叉淡化）。
- `Chapters/Ch0-Pain` … `Chapters/Ch10-Outro`（含 `Ch95-Roadmap`）：单个章节预览。
- `Pages/Page-*`：各页面静态重绘与点击目标预览。

### 3. 渲染

渲染完整视频：
```bash
npx remotion render LlamaWebPromoV2 out/llama-web-promo-v2.mp4
```

渲染指定帧（单帧检查画面）：
```bash
npx remotion still LlamaWebPromoV2 out/check/frame-300.png --frame=300 --scale=0.5
```

> `out/` 目录已被 `.gitignore` 忽略。

---

## 核心架构与配音机制

- **旁白为时间轴主轴**：
  - `src/narration.json`：旁白唯一来源，区分 `text`（画面字幕）与 `say`（TTS 朗读文字，做发音优化）。
  - 执行 `npm run vo`：调用 TTS 生成 `public/vo/*.mp3`（不提交），并生成实际音频时长的清单 `src/vo-manifest.json`（提交）。
  - 执行 `npm run vo:check`：只对配音通过 ASR 转回文本进行质检打分，不重新生成音频。
  - `src/story.ts`：根据 manifest 动态计算每个章节及每句旁白的起始帧与总帧数；各章节动画节奏均通过 `cue(ch, id)` 挂接节拍。旁白时长变化时，画面节奏自动对齐。
- **配音环境变量**：
  配音脚本依赖 OpenAI 兼容的 TTS/ASR 接口，配置在 `promo/.env`（已被 `.gitignore` 忽略，切勿提交）：
  ```env
  PROMO_TTS_BASE_URL=https://example.com/v1
  PROMO_TTS_API_KEY=sk-placeholder-key
  ```
  *(注：示例使用占位地址，切勿向代码库写入任何真实域名或 API key)*

---

## 转发能力说明与实测证据

宣传片中展示的所有服务接入与 API 转发能力均经过真实环境测试，绝非虚构概念：

- **已实测的转发能力**：
  - **聊天**（`/v1/chat/completions`）
  - **语音合成**（TTS，`/v1/audio/speech`）
  - **语音识别**（ASR，multipart，`/v1/audio/transcriptions`）
  - **生图**（`QwenImage-qwen-image-2.1` 等）
  - **改图**（`QwenImage-qwen-edit-2511`，multipart）
  - **生视频**（文生视频 `minimax-h3-t2v`、图生视频 `minimax-h3-i2v`，异步任务：`/v1/videos` 下单 → 轮询 `/v1/videos/{id}` → 下载 `/content`）
- **证据文件**：
  位于 `public/proof/` 目录下（`alpaca.png`、`alpaca-edit.png`、`video-t2v.jpg/mp4`、`video-i2v.jpg/mp4`）。
- **路线图**：
  仅在第 9.5 章（`Ch95-Roadmap`）展示，包含文生音乐、音乐编辑、Embedding、Rerank 等，全部明确标注「规划中」。

---

## 项目设计与工作文档

- [`HANDOFF.md`](HANDOFF.md)：会话之间的交接记录与当前进展备忘。
- [`BRIEF-v2.md`](BRIEF-v2.md)：第二版实现说明与硬规则（架构要求、镜头与字幕安全区、自查流程）。
- [`SCRIPT.md`](SCRIPT.md)：宣传片分镜头剧本与设计意图（各章节时长、画面主体、出处核对）。
- [`UI-REFERENCE.md`](UI-REFERENCE.md)：llama-web 真实界面 1:1 重绘参考规范（取色、字号、布局、各功能组件对照表）。

---

## 目录结构

```text
promo/
├── public/
│   ├── fonts/                 字体文件（Geist & Geist Mono）
│   ├── icon.png               应用图标
│   ├── proof/                 实测转发能力证据（图片、视频截图及样本）
│   └── vo/                    TTS 生成的配音音频（.gitignore，不提交）
├── scripts/
│   └── gen-vo.mjs             配音生成与 ASR 质检打分脚本
├── src/
│   ├── chapters/              12 个章节的动画组合组件（C0Pain … C10Outro、C95Roadmap）
│   ├── components/            共用视觉组件（AppIcon、Background、Captions、Nodes、Controls 等）
│   ├── pages/                 1:1 重绘的页面与弹窗组件（Setup、Models、Logs、UpstreamEditor 等）
│   ├── previews/              页面静态预览合成组件
│   ├── ui/                    界面积木组件库（lw.tsx、AppShell、Camera、networkLayout）
│   ├── lib/                   工具函数（anim.ts 补间计算、geometry.ts 几何、track.ts 关键帧轨道）
│   ├── copy.ts                开场概念与节点卡片所需文案及数据类型
│   ├── fonts.ts               字体加载
│   ├── narration.json         旁白台词（字幕与配音文本）
│   ├── vo-manifest.json       配音音频时长清单（由脚本生成并提交）
│   ├── story.ts               时间轴核心排期与 cue 计算
│   ├── theme.ts               视觉主题、色值、排版规范与视频规格
│   ├── index.ts               Remotion 入口
│   ├── Root.tsx               注册整片与各章节 Composition
│   └── PromoV2.tsx            第二版完整合成（12 帧交叉淡化串联各章节）
├── BRIEF-v2.md                第二版实现规范
├── HANDOFF.md                 交接记录
├── SCRIPT.md                  分镜剧本
├── UI-REFERENCE.md            重绘界面参考
├── package.json               工程依赖与脚本定义
├── remotion.config.ts         Remotion 配置文件
└── tsconfig.json              TypeScript 配置
```
