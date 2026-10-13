# 第二版实现说明（给执行代理）

你在 `promo/`（独立的 Remotion 4 工程，npm）里工作。动手前先读：`SCRIPT.md`（剧本）、`UI-REFERENCE.md`（真实界面，重绘的唯一依据）、本文件。每次任务的具体范围写在派活提示词里，**只做提示词里列出的事**。

## 1. 架构

- **旁白是时间轴的主轴**。`src/narration.json` 是旁白唯一来源，每条一个 id（如 `c2-3`）。配音文件是 `public/vo/<id>.mp3`，实际时长写在 `src/vo-manifest.json`（脚本生成，不要手改）。
- `src/story.ts` 根据 narration + manifest 算出每章每句的起始帧和章节总长。章节动画里的节拍一律写成**相对某句旁白的起点**：`cue('c2-3') + 10`，不要写死绝对帧号。这样旁白一改，画面自动跟着走。
- 页面复刻放 `src/pages/XxxPage.tsx`：纯组件，所有状态来自 props，导出 `XXX_LAYOUT`（点击目标、卡片位置，单位是应用原生像素 1440×810）。每个页面配一个静态预览合成（`Pages/Page-Xxx`），用红点标出 `XXX_LAYOUT` 里的点击目标。
- 章节动画放 `src/chapters/CnXxx.tsx`：只有这里读帧号。结构照抄 `src/chapters/C2Setup.tsx`：`SHOTS`（镜头轨道）、`CURSOR`（光标轨道）、`CLICKS`、`<Camera>` + `<AppShell>` + 页面 + `<Cursor>` + `<Captions>` + `<Voice>`。
- 现成积木：`src/ui/lw.tsx`（真实组件复刻）、`src/ui/AppShell.tsx`（应用外壳和侧栏）、`src/ui/Camera.tsx`（镜头）、`src/lib/track.ts`（关键帧轨道、点击反馈）、`src/lib/anim.ts`（`ramp`）。**先找现成的，没有再加**；新增的通用组件放进 `lw.tsx`。

## 2. 硬规则

- 颜色、字体只从 `src/theme.ts` 取，不写十六进制色值。
- 动画只用 `useCurrentFrame`、`interpolate` / `ramp`、`spring`、`track`、Remotion 的 `random(seed)`。不准用 `Math.random`、`Date`、`setTimeout`、CSS transition/animation。
- 界面文案一律照抄 `UI-REFERENCE.md` 和仓库里的 `../i18n/zh-CN.ts`，不自己编。拿不准就读 `../app/` 下对应的 `.vue` 源码。
- 只画已经实现的功能。禁用内容见 `UI-REFERENCE.md` 第 10 节。
- 示例只能用占位值：`X:\models`、`/Users/me/...`、`example.com`、`192.168.1.x`。不能出现真实路径、域名、key。
- **字幕区**：画面底部 150px（1080p）是字幕带。镜头推近时，正在讲的那块内容要落在字幕带上方。
- 浮层（请求气泡、提示框等）不能挡住旁白正在讲的那块内容；放到当时不重要的卡片上方。
- 光标必须正好落在点击目标中心（用 `XXX_LAYOUT` 里的坐标），按下有 `pressAt` / `rippleAt` 反馈。
- 不准读 `.env`，不准调用 TTS 接口，不准联网。不准改 `../`（主项目）里的任何文件。不准删除第一版的文件（`src/scenes/`、`timeline.ts`、`copy.ts` 等），除非提示词要求。

## 3. 完成前必须自查

1. `npx tsc --noEmit -p .` 和 `npx eslint src` 都通过。
2. 用 `npx remotion still <合成id> out/check/<名字>.png --frame=<n> --scale=0.5` 渲染提示词里指定的几帧，自己逐张看：有没有元素出画、重叠、文字被截断，光标是否在按钮上。
3. 最后用几行中文汇报：改了哪些文件、渲染了哪些帧、还剩什么问题。不要谎报没有跑过的检查。
