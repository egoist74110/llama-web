# 宣传片工作交接（2026-10-14，定稿）

## 现状

第二版定稿：约 2:55，含路线图与「生视频」（第 7 章，文生、图生视频已实测经 llama-web 转发）。第一版遗留已清理，README 已更新。成品 `out/llama-web-promo-v2-draft4.mp4`（不提交）。字幕与配音有 28/40 句文字不同是有意的（配音为避免 TTS 念错，用了中文说法）。

后续只有改动需求时才需要看下面的分工与配音说明。

## 2. 分工（用户定的，必须遵守）

- Claude 只做：架构、写派活说明、审核（渲染关键帧逐张看、扫代码）、小修。**体力活不要自己写。**
- 执行顺序：**agy**（`gemini-3.8-flash-high`）→ 没额度时 **codex**（`codex exec -m gpt-6.1-sol -c model_reasoning_effort="medium" -s workspace-write`，在 `promo/` 下跑）→ 再不行用 **Sonnet 子代理（effort medium）**。
- agy 命令：`agy -p "<提示词>" --model gemini-3.8-flash-high --mode accept-edits --sandbox --print-timeout 40m`，在 `promo/` 下运行，**串行**，派活前把 `src/` 复制到 scratchpad 做基线，事后 diff。日志里出现 `RESOURCE_EXHAUSTED` 就是没额度。
- 派活说明都基于 `BRIEF-v2.md`，每单列清楚：改哪些文件、不准碰什么、要渲染哪几帧自查。

## 3. 架构

- 旁白是时间轴主轴：`src/narration.json`（`text` = 字幕，`say` = TTS 念的文字）→ `npm run vo` 生成 `public/vo/<id>.mp3`（不提交）并写 `src/vo-manifest.json`（提交）→ `src/story.ts` 按实际时长算每句起点，章节动画用 `cue(ch, id)` 挂节拍。改旁白后画面自动对齐。
- 章节：`src/chapters/C0Pain … C10Outro`，另有 `C95Roadmap`（第 9 和第 10 章之间）。页面复刻在 `src/pages/`，积木在 `src/ui/`。整片合成 `LlamaWebPromoV2`（`src/PromoV2.tsx`，章节间 12 帧交叉淡化）。
- 渲染：`npx remotion render LlamaWebPromoV2 out/<名字>.mp4`（约 1 分钟）；静帧 `npx remotion still <合成id> out/check/x.png --frame=N --scale=0.5`。

## 4. 配音（重要，踩过很多坑）

- TTS：OpenAI 兼容接口，经用户自己的 llama-web 转发。地址和 key 在 `promo/.env`（`PROMO_TTS_BASE_URL`、`PROMO_TTS_API_KEY`，已被 gitignore）。**地址是个人域名，不能写进仓库任何文件。** 用 curl / Node fetch；Python urllib 会被 Cloudflare 拦（403/1010）。
- 音色 `TTS-诗歌剧_ZH`，1.1 倍速 + 去首尾静音 + loudnorm（后处理版本 `p3`，原始音频缓存在 `public/vo/raw/`，只改后处理不会重新请求接口）。
- 自动质检：`gen-vo.mjs` 每句最多生成 5 版，用语音识别模型 `MOSS-OpenMOSS-Team/MOSS-Transcribe-Diarize`（经 llama-web，multipart）转回文字打分，≥0.9 停，留最高分。`npm run vo:check` 只打分不生成，`npm run vo -- --redo-below` 重做低分句。c1-1、c10-1（品牌名 llama web）门槛 0.3，需要人耳确认。
- `say` 的写法规则写在 `narration.json` 的 `_doc` 里：纯中文、只用 ，。？、不念英文和按钮名。这个音色念不好的词：上下文、生成、只（变「即」）、社区分支、链路、启动参数、生图（变「相图」，改说「画图」）、「？」后接「先」。分数低就换说法，不要硬重试。
- BGM：**用户决定不要了。**

## 5. 已实测、可以写进片子的能力（经 llama-web 转发）

聊天、语音合成（TTS）、语音识别（multipart，主项目决定 58）、生图（`QwenImage-qwen-image-2.1`，需 `response_format: "b64_json"`）、改图（`QwenImage-qwen-edit-2511`，multipart）。证据图在 `public/proof/alpaca.png`、`alpaca-edit.png`。

**生视频**：主项目另一个会话已实现「异步任务 id → 上游」映射，用户说 2026-10-13 已真机测通（文生视频 `minimax-h3-t2v`、图生视频 `minimax-h3-i2v`）。**接手后先自己经 `.env` 再测一遍**（`GET /v1/models` 找到两个视频模型的完整名字 → `POST /v1/videos` → 轮询 `GET /v1/videos/{id}` → 下载 `/content`），确认后才能写进片子。

路线图（第 9.5 章，全部标「规划中」，文字照用户原话，不许加功能）：文生音乐、音乐编辑（ACE-Step）、Embedding、Rerank。

## 6. 下一步（按顺序）

1. 自测生视频（见上）。成功的话从成品里截一帧或做一个几秒的小片段放 `public/proof/`（视频文件若太大就只用截图）。
2. 改第 7 章旁白 c7-4：字幕加「生视频」，`say` 照规则写（例：「凡是兼容的接口，聊天之外，语音合成，语音识别，画图改图，还有视频，也照样转发。」），`npm run vo` 后看分数。
3. 派 agy：请求表在改图那一行后加一行视频（`/v1/videos`），对比卡片旁加视频首帧/小片段；注意不能挡住新行、不能压字幕带。审核关键帧。
4. 渲染第四版整片，发给用户看。
5. 定稿后收尾（问用户再做）：删第一版遗留（`src/scenes/`、`timeline.ts`、`copy.ts` 中不再用的部分、`BRIEF.md`、旧合成 `LlamaWebPromo`），更新 `promo/README.md`，问用户后提交（`public/vo/`、`out/` 不提交；`public/proof/` 和 `src/vo-manifest.json` 要提交）。

## 7. 规则备忘

- 只写已实现、已实测的能力；计划中的只能出现在路线图里并标「规划中」。
- 示例只用占位值（`X:\models`、`/Users/me/...`、`example.com`、`192.168.1.x`）。
- 审核时重点看：元素太小、出画、重叠、浮层挡住正在讲的内容、关键内容被底部 150px 字幕带挡住、执行代理自己加的不存在的功能或文案。
