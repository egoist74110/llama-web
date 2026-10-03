# 交接记录

## 2026-10-03 · 工作包 8-1 · Sonnet 5.5
- 完成：plan 8-1 五项打勾。`server/core/runtimes.ts`（引用串 `cuda:b123` / `cpu:` / `metal:` / `custom:<id>`、`runtimes.json` 登记含损坏恢复、PE / Mach-O / ELF 文件头识别、`resolveRuntimeRef` 与兜底、`refOfExe`）、`runtime-add.ts`（目录 / 压缩包 / GitHub 三种来源：先暂存预览再确认）、`runtime-manager.ts`（列表、删除保护、`protectedTags`）；`launch.ts` 按 方案 ← 模型 ← 全局 解析并在 plan / preview 里带 `runtime`；`models-admin` 加 `runtime` 字段校验（只能选本机平台的版本）；`Updater` 自动清理的保护集加入被选中的版本；兜底时写 `runtime-fallback` 事件（总览「最近事件」和日志事件页能看到）。接口：`/api/llamacpp/add/{preview,confirm,cancel}`、`delete-plan`、`DELETE /api/llamacpp/:ref?confirm=1`、`POST /api/models/:id/runtime`，GET 多返回 `runtimes`。
- 验证：`bun test` 779 pass / 0 fail（新增约 76 个）；`bun run typecheck` 通过（故意写错确认它真的在检查）。真机：用本机已装的 b11146 目录跑了一次真实「目录 → 暂存 → 运行真实 `--version` → 登记」（4.5 秒、740 MB、识别为 CUDA / b11146），Mac 目标识别不到 `llama-server` 而拒绝；临时数据目录，已清理。
- 没测：真实 GitHub Release 下载（只有假 fetch）；macOS（Mach-O 头、`.tar.gz` 在 Mac 上的解压、quarantine / 可执行权限用注入函数测，真实行为留给 8-6 的 macOS runner）；从界面走一遍（8-5 才做界面）；`custom/` 里的真实进程被残留清理（用注入的进程表测）。
- 决定 / 坑：① `--version` 在**预览**阶段就会运行所选程序，8-5 的界面必须在调用预览前先弹「这会运行你选的程序」。② 同一时刻只暂存一个预览，新预览替换旧的，30 分钟过期，启动时清 `.stage-*` / `.del-*`。③ GitHub 来源只认 `https://github.com/`（含资产下载地址），Windows 取 CUDA（有 cudart 就一起装）或 CPU，Mac 只认与本机架构一致的资产；没有公布 SHA-256 时预览返回算出的值，确认要 `acceptUnverified: true`。④ 删除是同步的（改名 → 改模型引用 / 登记 / 当前版本 → 删目录），中途失败会把目录改回去。⑤ 全局「当前版本」仍是 `settings.llamacpp.current`（只管 `acceleration` 选中的那个通道）；`POST current` 的通道参数和 `currentCpu` 留给 8-2。⑥ 全局没有引用时的行为完全没变（旧测试没改）。⑦ 兜底只针对**有引用**的情况；全局 current 缺失仍走原来的 `no-runtime` 前置条件。
- 剩余：无（8-1 范围内）。`/api/llamacpp` 的界面、兜底提示条在 8-5。
- 下一步：8-2（Opus 5.5，指南 #p8-2）。

---

## 2026-10-03 · llama.cpp 多 GPU 调研 · Codex
- 完成：只调研并新增 `docs/research/multi-gpu.md`；梳理官方多 GPU 参数、当前主线 `tensor` 实验限制、CUDA Release 及与阶段 8/9 的接入关系。未改代码或 `plan.html`。
- 验证：本机 `llama-server --version` = `0.5.0-dev` build 11146 / commit `7fe450e19`；`--list-devices` 只列出 1 张 RTX 5090（32579 MiB 总量、30991 MiB 空闲），没有加载模型；浏览官方文档和 Release，并引用一份公开 V100 实测。未跑测试；没有多卡性能实测。
- 剩余：等用户审阅是否扩展阶段 8 决定 39、增加多 GPU 工作包，以及四个产品决策（详见研究文档）。
- 决定 / 坑：`--tensor-split` 顺序受 `--device` 顺序影响；多 GPU 需按设备逐卡估算显存；官方当前 `tensor` 模式有架构、Flash Attention、KV cache 和 `--fit` 限制。
- 下一步：由用户决定是否纳入阶段 8；本次按用户要求未提交。

---

每个会话结束时在**最上面**追加一条，30 行以内。新会话只需要读最上面一条。
不要写入个人路径、域名、key。

格式：

```
## YYYY-MM-DD · 工作包 X-X · 模型
- 完成：…（对应 plan 的哪几项）
- 验证：实际运行的命令和结论
- 剩余：没做完的部分（没有就写「无」）
- 决定 / 坑：实现中做的、后面的会话需要知道的决定和踩到的坑
- 下一步：下一个工作包编号
```

---

## 2026-10-03 · 多 GPU 决定写入计划 · Sonnet 5.5
- 完成：用户看完 `docs/research/multi-gpu.md` 后定了四点（默认单卡且为显存最大的一张、可多选至少一张、多选自动多卡；切分模式全开放，`tensor` / `row` 启用前验证；全局 / 模型 / 方案三层都有但默认单卡、需打开才显示多选；显存估算按实际启用的卡逐卡算），已写成 plan 关键决定 45、阶段 8 新增 8-7、决定 39 / 43 加指向、阶段 9 依赖 8-7、指南 8-7 卡片；阶段 9 的待确认项也定了（上限 1–99、放不下不提供强行启动）。阶段 7 关口用户说不用试用，视为通过。
- 验证：只改文档，没改代码，没跑测试。
- 剩余：8-1 起都没开始；阶段 8 关口现在在 8-7 之后。
- 下一步：8-1（Opus 5.5，指南 #p8-1）。

---

## 2026-10-03 · 工作包 7-2 · Sonnet 5.5
- 完成：plan 7-2 三项打勾。向导「选择方式」新增第三项「没有域名，用临时地址」（只在首次设置里出现；选它后步骤是 端口 → key → 选择方式 → 连接，连接时写入 `tunnelMode: 'quick'`，其他方式写回 token；连接页明说临时地址的限制）。总览显示隧道方式；「高级」里可在「自有域名 / 临时地址」切换、选隧道协议（HTTP/2 推荐 / QUIC 备用）；临时模式隐藏「再加一个地址」和隧道 token；状态文案不提 token。地址列表（`PublicAddresses.vue`、总览公网小卡）和服务端用同一规则：`publicAddresses` 拆到 `server/core/public-addresses.ts`（`public-check.ts` 仍重导出，测试不用改）。README 新增「方式 C」，README / `docs/windows-desktop.md` 写明卸载清理。文案全在 `i18n/zh-CN.ts`。
- 验证：`bun test` 703 pass / 0 fail；`vue-tsc -b --noEmit` 无输出（`bun run typecheck` 在本机被 GameGuard 弄崩，沿用 7-1 的做法）。源码版（`nuxt dev`，临时数据）在浏览器面板走了向导：选第三项 → 4 步 → 连接，`settings.public.tunnelMode` 变 quick、限制说明显示、完成后总览「高级」有方式 / 协议、无 token 区、无「再加一个地址」。真机冒烟（用户同意；独立目录构建、临时数据、没碰仓库 `.output` / `data/` / `~/.cloudflared`，已清理）：本机已装 cloudflared 被复制到 `runtime/cloudflared/win32-x64/`，临时隧道连通；经 `*.trycloudflare.com` → llama-web 公网入口（:18080）→ 假 llama-server：无 key 401、错 key 401、带 key 访问 `/api/settings` 和 `/` 都 404、`/v1/models` 200、非流式 200、流式 31 个事件分 31 次读到（首条 34 ms）；自检返回 401（ok）。关闭托管后 cloudflared 退出、`pids.json` 只剩模型进程；切 QUIC 重启后地址换了新的；关闭公网访问后无 cloudflared；强杀 llama-web 后无 cloudflared / llama-server 残留；数据目录里 cloudflared 相关只有 `quick-tunnel.yml` 和 exe。
- 没测：从零下载 cloudflared（本机有已装的，只走了「复制」；下载路径只有单元测试）；用真实 llama-server（用户同意的是真实，我改用假的以免占 GPU，直连真实 llama-server 的流式 7-1 已测）；桌面安装包里的新界面；窄屏 / 深色下新向导选项的样式；总览公网小卡在临时模式下的实际显示（只看了代码）；某次开关后 8 秒内没见到 cloudflared 进程，之后重复十几次都在 3–4 秒内起来，没复现。
- 决定 / 坑：临时模式的向导选项只在首次设置里给（「再加一个地址」对临时隧道没有意义）。工作区里原有的未提交改动（首次使用引导、阶段 8 规划文档）一并进了这次提交，因为 `i18n/zh-CN.ts`、plan、handoff 是同一批文件无法拆开。Windows 下 curl 刚连通的 trycloudflare 地址可能解析不到，等几秒（DNS 传播）；自检接口是服务端请求，更稳。
- 剩余：无（7-2 范围内）。
- 下一步：阶段关口 7，等用户试用确认：开启公网访问 → 选「没有域名，用临时地址」→ 拿到地址后用客户端带 key 试聊天（含流式）→ 「高级」切模式 / 协议。确认后才进入阶段 8（先问阶段 8 开头的待确认问题）。

---

## 2026-10-03 · 阶段 8 规划（运行库、设备与用量） · Sonnet 5.5
- 完成：用户一次性提出一批需求，已写成 plan 阶段 8（8-1 至 8-6 + 审查 + Mac 专项）、关键决定 34–40、接口 / 坑位 / 变更记录，以及指南阶段 8 卡片。内容：手动添加 / 删除 llama.cpp 版本（目录 / 压缩包 / GitHub 地址）、按模型和配置方案选版本、全局默认 GPU / CPU 两份 + 本机检测、单设备选择、30 天用量日志、模型页添加目录、Mac 单独处理。
- 验证：只改了文档（plan.html、claude-guide.html、handoff.md），没改代码，没跑 `bun test` / typecheck；plan.html 在浏览器面板里打开过但没逐段看渲染。
- 用户的硬性要求：最新官方版不可删；启动时版本缺失用同通道最新官方版兜底（不改保存的配置）；Mac 与 Windows 版本互相隔离，Mac 上界面不出现任何 GPU 相关内容；尽量把 Mac 做全。
- 待用户确认（plan 阶段 8 开头）：「git 地址」按 Release 下载理解；目录添加复制进 data/runtime；用量日志做汇总；「多 CPU」含义；是否纳入 AMD / Intel；Mac 套壳 / 启动脚本是否另开包。
- 坑：阶段 7 的 7-2 和关口未完成；工作区仍有首次使用引导的未提交改动（上一条交接），本次没碰。现有 UI 里有 Mac 的 GPU 提示文案（`macHint`、`runtimeHint`），与新要求冲突，8-6 要清掉。关键决定 14「只用官方最新版」已放宽。
- 追加（同一会话）：用户要求放开单开限制、多开前做显存检测、保存设置时多方面检查、外部请求触发的多开放不下也要拦住 → 写成阶段 9（关键决定 41–44，9-1 至 9-4 + 审查，依赖 8-3 的设备选择）。会改核心行为规则（决定 9），9-3 前须用户确认规则文字；升级后上限默认仍为 1。待确认：请求触发时是否允许卸载空闲模型腾地方。
- 用户后续确认：多 CPU = 多路 CPU（很少见，按检测结果来）；暂不考虑 AMD / Intel；多开由设置开关控制（默认关），请求放不下时用户二选一「卸载上一个 / 服务端报错」；Mac 套壳另开工作包。随后用户确认：git 地址按 Release 下载、目录复制进 data/runtime、用量日志做汇总、Mac 启动脚本 start.command 放进 8-6。待办只剩阶段 7 关口与工作区未提交改动的处理。
- 剩余：8-1 起都没开始。
- 下一步：先问用户是否进入阶段 8 并确认上面的问题，然后 8-1（Opus 5.5，指南 #p8-1）。

---

## 2026-10-03 · 首次使用引导（用户追加，非编号工作包） · Sonnet 5.5
- 完成：审查首次使用全流程，发现三处缺口并补上（plan 关键决定 33，阶段 7 下新增一节两项，已打勾）：① 旧向导只有一个路径输入框，且混着作者自用的 llama-swap 导入；② 从扫描启用模型后 mmproj / MTP 永远是 null，用户得自己进编辑抽屉；③ 第一次点启动没有任何确认。现在：向导三步说明 + 多目录 +「选择文件夹…」（`server/core/folder-picker.ts`，PowerShell `FolderBrowserDialog`，`POST /api/fs/pick-folder` 只认 localhost / 127.x / [::1] 的 Host）+ 粘贴路径；`ModelConfig.confirmed`（planEnable 写 false，缺省 = 已确认）→ `needsSetup` → `ModelCard` 启动前弹 `FirstStartDialog`（思考开/关、视觉、MTP + 倍数，同目录候选文件），`POST /api/models/:id/setup` 调 `applyFirstSetup` 写进当前方案并启动。
- 验证：`bun test` 700 pass / 0 fail（新增 `tests/core/first-setup.test.ts`）；`nuxt prepare` 后 `vue-tsc -b --noEmit` 无错误。源码版（`nuxt dev`，临时数据目录 + 假 llama-server + 假 gguf：模型 / mmproj / MTP 各一个）在浏览器面板走了一遍：自动进向导 → 粘贴路径添加并扫描（找到 1 个）→ 完成进入扫描发现 → 启用 → 启动弹框（视觉、MTP 已选上，倍数 3）→ 确认后 models.json 里 mmproj / draft / `reasoning on, reasoningBudget -1` / `--spec-type draft-mtp --spec-draft-n-max 3` 都对，模型进入运行中；`/api/fs/pick-folder` 带非本机 Host 返回 403。临时进程和 `.cache/8-1` 已清理。
- 没测：「选择文件夹…」的原生窗口（真实弹出、取消、中文路径）没点过；浅 / 深色、窄屏下的向导和确认框没看；桌面安装包没重新构建；思考「关」和 MTP 对真实 llama-server 的实际效果没验证（只验证了写入的参数）；深色和 mmproj 多候选时的下拉没看。
- 决定 / 坑：拖拽目录不做（浏览器拿不到完整路径，用户选了「只做选择按钮 + 粘贴」）。思考「开」写 `--reasoning-budget -1`（llama.cpp 里 -1 才是不限，0 是关闭，和用户口述的「0 不限制」不一致，已在决定 33 注明）。是否自带 MTP 没法从 GGUF 判断，所以没有同目录 MTP 文件时开关照样可开，由用户决定。工作区里 `server/core/tunnel.ts`、`tests/core/tunnel.test.ts`、`docs/reviews/stage-7-codex.md` 的改动不是这次做的（会话开始时工作区是干净的，审查会话产生），没碰，也没有提交本次改动。
- 剩余：无（上面「没测」的项请试用时看）。
- 下一步：7-1 审查的意见处理，然后 7-2。

---

## 2026-10-03 · 阶段 7 审查意见处理 · Opus 5.5
- 完成：`docs/reviews/stage-7-codex.md` 三条都已标注。S7-001 已修复：新增 `cloudflaredEnv()`，两种模式都去掉继承的全部 `TUNNEL_*`（大小写不敏感），token 模式只写回保存的 token。S7-002 已修复：`quickTunnelHost` 只按日志前缀级别和 `error=` 字段判断错误行，地址里的 error / err / wrn 单词不再误判。S7-003：计划文字澄清（只有临时模式换端口重启，token 模式行为不变），并修复 token 模式换端口后 hostnames 仍按旧端口筛选的问题（记住最近一次配置行，按新端口重新筛选）。
- 验证：`bun test` 703 pass / 0 fail；`bun run typecheck` 退出 0。两项都在包含另一会话未提交改动（首次启动 / 目录选择相关）的工作区里跑的；这些改动没提交、没碰。没有真实隧道验证。
- 剩余：无（审查范围内）。审查报告里建议的完整链路验收（quick 隧道 → :8080 → proxy，401 / 404 / 流式 / 断开）放在 7-2 真机冒烟。
- 决定 / 坑：剥离全部 `TUNNEL_*` 也作用于 token 模式（以前只删 TUNNEL_TOKEN），环境变量不再是 cloudflared 的隐式输入。
- 下一步：7-2（Sonnet 5.5，提示词在指南 #p7-2）。

---

## 2026-10-03 · 工作包 7-1 · Opus 5.5
- 完成：plan 7-1 四项打勾，另加一项（用户会话中追加，关键决定 32）也已完成。`public.tunnelMode`（token / quick）和 `public.tunnelProtocol`（http2 默认 / quic），settings v5 迁移（旧配置 → token + http2）、normalize 回落、`applyPublic` 校验、`cleanWizard` 接受 `path: 'quick'`、一键完成写回 token。`TunnelManager`：`Launch`（模式 / token / 端口 / 协议）决定是否重启；临时模式不要 token、环境里删掉 TUNNEL_TOKEN；参数 `tunnel --no-autoupdate --protocol <p> --config data/runtime/cloudflared/quick-tunnel.yml --url http://127.0.0.1:端口`；`TunnelInfo` 新增 `mode`、`quickHost`（启动、重启、进程退出、停止时都清空）。`publicAddresses(pub, tunnel)` 和 `/api/public/check` 在临时模式下只用 `quickHost`。用户确认阶段 6 关口的方式：直接发起了 7-1。
- 验证：`bun test` 693 pass / 0 fail；类型检查 `node node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit` 通过（**`bun run typecheck` 被 GameGuard 弄崩**，本机开着 GameMon；用故意写错的文件确认过 vue-tsc 确实在检查）。实测（用户同意，临时目录，没碰仓库 data/ 和 ~/.cloudflared，cloudflared 2026.5.0）：① 临时 HOME 里放带 tunnel + ingress 的 config.yml：不带 `--config` 时隧道照样连上，但 `GET /` 返回 **404**（被那份 ingress 接管）；带上我们的 `--config` 后返回 502（路由到了空端口 9，正确）→ `--config` 是必要的，已写进决定 31。② 用 TunnelManager 临时模式 + 真实 llama-server（只绑 127.0.0.1，随机 --api-key，一个已配置模型，200 token）跑 HTTP/2、QUIC 各一次：都是不带 key 返回 401、非流式 200、流式 200 个事件分 198 / 199 次读到，首条 0.18 / 0.13 秒（本机直连 0.11 秒）→ 流式正常，和决定 31 一致；cloudflared 的 Registered 行确认 protocol=http2 / quic；关闭后 cloudflared 进程退出、pids.json 为空，没有残留进程。
- 没测：经 llama-web 公网入口（:8080）的完整链路，这次直连 llama-server 的 --api-key（入口代码没改）；从零下载 cloudflared（这次复用本机已装的）。这两项都放在 7-2 的真机冒烟里。
- 剩余：无（7-1 范围内）。界面全部留给 7-2：`PublicAddresses.vue` 和 `pages/index.vue` 目前还直接用 `domain` + `hostnames`，临时模式要改用 `quickHost`（plan 7-2 已写）；协议选择界面也在 7-2。
- 坑：`shutdown()` 后 status 仍停在 connected（原有行为，只在退出时调用，没改）。Windows 下 env 键名大小写不同的 `tunnel_token` 不会被删除（极少见）。
- 下一步：7-1 审查（gpt-6.1sol，指南「阶段审查」提示词，范围限定在 7-1 的改动），然后 7-2（Sonnet 5.5）。

---

## 2026-10-03 · 阶段 7 规划（免域名临时隧道） · Sonnet 5.5
- 完成：用户要求公网向导新增「没有域名，用 Cloudflare 临时隧道」，cloudflared 本地解决、卸载清理干净。新增关键决定 31、plan 阶段 7（7-1、审查、7-2）、指南阶段 7 卡片（含各包推荐模型：7-1 Opus 5.5、审查 gpt-6.1sol、7-2 Sonnet 5.5）。
- 验证：只改了文档（plan.html、claude-guide.html、handoff.md），没改代码，没跑 `bun test` / typecheck。
- 剩余：7-1、7-2 都没开始。
- 决定 / 坑：现有 `server/core/tunnel.ts` 已经会把 cloudflared 复制或下载到 `data/runtime/cloudflared/`，临时模式直接复用。方案草稿：`public.tunnelMode`（settings v5）、`TunnelManager` 的 `--url` 模式、地址取自输出里的 `*.trycloudflare.com`。**评估性实测（临时脚本，已清理，cloudflared 2026.5.0，假 SSE 服务每秒一个事件）：GET 被缓冲（8.7 秒后一次性到达），POST 逐条到达（首条 1.0 秒）。LLM 流式是 POST，所以值得做；还没用真实 llama-server 测，7-1 复测。** `~/.cloudflared/config.yml` 可能影响临时隧道，也要实测。阶段 6 关口还没得到用户确认，7-1 开始前先问用户。
- 下一步：7-1（Opus 5.5，提示词在指南 #p7-1）。

---

## 2026-10-03 · 发布 v0.1.0-beta.2 · Sonnet 5.5
- 完成：应用户要求发布 v0.1.0-beta.2（prerelease，tag → 273945a）。版本号我定的（用户没指定）：package.json、Cargo.toml、Cargo.lock 各改一行，写了 `docs/release-notes/v0.1.0-beta.2.md`，手动触发草稿 workflow，CI 全部步骤通过。
- 验证：从草稿下载安装包，SHA256 与 SHA256SUMS 一致，`bun desktop/check-package.ts` 通过（338 个文件），确认后 `gh release edit --draft=false`。没有安装运行安装包，没测 beta.1 → beta.2 的应用内升级，没有在干净机 / 无 NVIDIA 机器上试用；发布说明里已写明。
- 剩余：安装版里的新界面逐页试用、应用内升级实测（可借这次真实的两个公开版本做）。
- 下一步：无。

---

## 2026-10-03 · 工作包 6-2 · Sonnet 5.5
- 完成：plan 6-2 三项打勾。模型页：已启用改为列表行（`ModelCard`，状态胶囊 `StatusPill`、量化 / 视觉 / 草稿标签、方案下拉、编辑图标、启动 / 停止 / 重试，加载进度条和失败卡在行内）、扫描发现改卡片网格（`DiscoverPanel`）、新增筛选框与分段切换；编辑抽屉改文件 / 配置方案 / 参数三栏（`ModelEditor`，逻辑不变，所有 ProfileForm 仍保持挂载，命令预览与重复参数警告还在参数栏里）。日志页：一行工具栏，模型输出终端风格（按行文本判断 err / warn / eval 着色），事件时间线，请求表格。设置页：左侧分区目录（滚动跟随高亮）+ 分区卡片，llama.cpp 版本改单选行。`AppCard` / `PageHeader` 改成新样式（向导和设置、导入、公网向导都用它们），公网向导里的小方框圆角统一 10px。删除 `StateDot` / `StateBadge`。文案新增在 `i18n/zh-CN.ts`（models.filter、models.edit.tabs / paramsFor、logs.view、settings.toc）。
- 与交互稿差异（数据里没有或会新增功能的没做，已写进变更记录）：模型行没有大小 / 上下文标签（实时数据没有；量化取文件名）；日志页没有「下载」按钮（没有接口，没新增）；日志的「时间范围」仍是原来的「实时 / 文件」选择。
- 验证：`bun test` 675 pass / 0 fail，`bun run typecheck` 通过（改完后各跑了一次）。源码版（`bun run dev`，临时数据目录 + 假 llama-server）在浏览器面板看了：模型页启动 / 运行中、编辑抽屉三栏、扫描发现卡片、日志（模型输出 / 请求）、设置页（深色，目录跳转），深浅色切换，390 宽下四个页面 + 向导无横向溢出（只用脚本量了 scrollWidth，模型页窄屏截图看过；日志 / 设置窄屏、事件标签页、加载中 / 失败行、首次向导、公网向导和各对话框的新样式**没有逐一截图看**）。**桌面安装包没有重新构建验证**，验收标准里的「桌面安装包实际打开看过、断网字体」本轮没做，用户试用时请用 `start.bat build` 或 `bun run desktop:build` 看。
- 坑：`bun run dev` 会按 `LLAMA_WEB_DATA` 指定的目录初始化；目录里没有 settings 时会触发 llama.cpp 自动下载（约 700 MB），要先用 `.cache/6-1/setup.ts` 那种方式播种配置（autoUpdate 关）。本轮第一次启动就踩了：数据目录是 `.cache/` 下的临时目录，没碰仓库 `data/`，已删。
- 剩余：阶段关口 6，等用户试用确认；上面「没有逐一截图」的页面请重点看。
- 下一步：无（阶段 6 到此）。用户确认后才有新工作。

---

## 2026-10-03 · 工作包 6-1 · Opus 5.5
- 完成：plan 6-1 三项打勾。设计变量（main.css，浅 / 深两套映射到 Nuxt UI 变量，primary indigo / neutral gray）、本地 Geist 字体（新依赖 `@fontsource-variable/geist`、`geist-mono`，用户同意；`ui.fonts: false` 关掉 @nuxt/fonts）、左侧栏 `AppSidebar`（≥820px 侧栏固定、只有 `.lw-main` 滚动；窄屏侧栏在上、导航横排）、总览 `pages/index.vue` + `OverviewHero`。新组件用 `lw-*` 类（`lw-card` / `lw-chip` / `lw-st-*` / `lw-seg` / `lw-bar` / `lw-tbl`），6-2 沿用。纯逻辑在 `app/utils/overview.ts`（有测试），速度曲线由 `useSpeedTrend`（布局里启动，每秒从 useLive 采样）。日志页支持 `?tab=events|requests`。
- 与交互稿差异（数据里没有的不显示，已写进变更记录）：最近请求的「速度」列改「耗时」；llama.cpp 小卡无 CUDA 标签；无 nvidia-smi 时显存卡隐藏；更新提示条只留「查看更新」+ 本次关闭；ctx 取命令预览接口（实例变化时取一次），量化取文件名。
- 验证：`bun test` 675 pass / 0 fail，`bun run typecheck` 通过（收尾时开着带 GameGuard 反作弊的游戏，Bun 启动子进程会崩溃，关掉后重跑通过）。源码版（独立 worktree 构建，端口 5091，临时数据 + 假 llama-server）在浏览器面板看了浅 / 深 / 1280×600 / 390 宽：运行中（实时 t/s、曲线）、加载中进度、加载失败卡、空状态、断线横幅、模型 / 设置页在新骨架下可用，桌面宽度整页不滚动、侧栏不动、无外部请求、字体为本地 Geist。桌面版：`bun run desktop:build` 出的 0.1.0-beta.1 本地包装到测试目录，经 WebView2 调试端口截图浅 / 深 / 窄屏（`.cache/6-1/shots/`），本地字体、无外部请求、剪贴板可用、关窗进程退出、卸载 0。断网启动没有单独测（字体全在包内、页面没有外部请求）。更新提示条新样式没有实际触发看过。
- 事故：`bun run build` 会先清空仓库 `.output`；用户自己的实例当时正从 `.output` 运行（:5001），被弄坏，用户已停掉。现在仓库 `.output` 是 a74a939 的构建（旧界面）；要用新界面需 `start.bat build`。以后测试一律在独立 worktree 构建，不碰仓库 `.output`。
- 坑：静默安装（/S）后安装包会自动启动应用（默认数据目录），再用自定义环境启动会被单实例挡掉、立即以 0 退出；测试脚本要先结束自动启动的那个（见 `.cache/6-1/desktop-check.ts`），并清理 `%LOCALAPPDATA%\io.github.llama-web.desktop`（本轮已删）。`tauri build` 又改了 Cargo.lock，已 checkout。
- 剩余：无（6-1 范围内）。旧组件（StateDot / StateBadge / PageHeader / AppCard 等）6-2 仍在用，6-2 结束时删不用的。
- 下一步：6-2（Sonnet 5.5，提示词在指南 #p6-2），完成后阶段 6 关口停下等用户试用。

---

## 2026-10-03 · 阶段 6 规划（界面重设计交互稿） · Opus 5.5
- 完成：用户觉得第一版界面是临时凑合的，做了可交互的设计稿并获确认（没有意见；要求桌面宽度下侧栏固定不滚动、只有内容区滚动）。新增关键决定 30、plan 阶段 6（6-1、6-2）、指南阶段 6 卡片；交互稿源文件存到 `docs/design/ui-v2-prototype.dc.html`。
- 验证：只改了文档，没改代码，没跑 `bun test`。交互稿没有在浏览器里截图核对过。
- 剩余：6-1、6-2 都没开始。
- 决定 / 坑：交互稿是设计画布格式（`<x-dc>` 模板 + `renderVals()`），不能直接用浏览器打开，读源码取数值即可；里面的模型名、数字、版本号、地址都是示例。端口按真实默认值 5001。字体 Geist 必须随包本地提供（桌面版可能断网），新增依赖前先问用户。
- 下一步：6-1（Opus 5.5，提示词在指南 #p6-1）。

## 2026-10-03 · 工作包 5-3（已发布） · Opus 5.5
- 完成：用户确认后发布 v0.1.0-beta.1（prerelease，tag → dba2238），plan 5-3 主任务打勾。仓库本来就是公开的，未做更改。
- 验证：匿名从公开 Release 下载，安装包与验收过的草稿逐字节一致，SHA256SUMS 通过；用 `pickUpdate` 跑真实公开 API：0.1.0-beta.0 → beta.1（安装包摘要 + SHA256SUMS 齐全），beta.1 本身无更新，正式版用户不收预发布。发布后只有文档改动，提交前 `bun test` / typecheck 重跑。
- 剩余：5-2 第二项（干净机 / 无 NVIDIA）仍未打勾；两个公开版本之间的线上升级要等下一个版本时实测。CR-013（公开历史里的真实隧道名）仍待用户决定。
- 下一步：阶段 5 关口，停下等用户试用。下一版：改 package.json（同步 Cargo.toml / Cargo.lock 那一行）、写 docs/release-notes/v<版本>.md，手动触发 workflow，从草稿下载验收后发布。不做 Mac，除非用户另行要求。

---

## 2026-10-03 · 工作包 5-3（草稿已就绪，待用户确认发布） · Opus 5.5
- 用户确认：v0.1.0-beta.1、MIT、未签名；要求现代化应用更新（新增决定 29）。用户未在干净机 / 无 NVIDIA 试用，5-2 第二项继续不打勾。
- 完成：plan 5-3「应用内更新」打勾。设置页「关于与更新」、提示条 + 更新说明对话框、跳过、桌面版下载双重校验 + 壳复核后被动安装、源码版链接发布页；LICENSE、版本单一来源；手动触发的草稿 Release workflow、包内容 allowlist 检查、发布说明 `docs/release-notes/v0.1.0-beta.1.md`。草稿 prerelease 已生成（未建 tag）。主任务未打勾：发布须用户确认。
- 验证：`bun test` 669 pass（本机），typecheck，Rust 8 pass；CI 全部步骤通过（一次 5-1 身份探测计时失败，重跑通过）。从草稿下载包：SHA256 一致、包检查通过、安装 / 四页面 / 假模型 / 关窗清理 / 卸载保留数据、应用内升级到本机 beta.2 测试包通过。详见 `docs/windows-desktop.md` 5-3 节。
- 剩余：用户确认后发布草稿（`gh release edit v0.1.0-beta.1 --draft=false`），再从公开 Release 下载复核并给 5-3 主任务打勾；真实两版本间的线上升级、干净机 / 无 NVIDIA 未验。CR-013 历史仍待用户决定。
- 决定 / 坑：NSIS 语言选择框会卡住被动安装，已关闭。cargo test 依赖生成的 resources，CI 中放在构建后。改版本只改 package.json（Cargo.toml / Cargo.lock 的包版本同步改一行即可；tauri build 会重写 Cargo.lock，构建后 checkout 再改那一行）。基线时运行的源码版实例在测试期间停止，原因未查明（脚本未按名称 / 端口结束进程）。
- 清理：测试安装、数据、应用本地目录已删；`.cache/5-3`（脚本、日志、截图、草稿下载、本机 beta.1 / beta.2 测试包）有意保留。
- 下一步：等用户审阅草稿并确认发布；阶段 5 关口后停下。不做 Mac。

---

## 2026-10-02 · 工作包 5-2（第三次接续，本机验收完成） · Opus 5.5
- 完成：plan 5-2 第一项（Tauri 验证与薄壳）打勾。第二项本机部分全部通过，但缺干净 Windows / 无 NVIDIA，不打勾。修复：端口冲突经私有管道报原因码，启动页显示中文原因（原来只有 `Service exited`）；运行缓存从 `data/run/desktop` 移到应用本地数据目录的 `rc`（深数据目录使 sharp DLL 超出 LoadLibrary 路径上限，服务起不来）；首次下载失败提示重新打开会重试；测试包版本 0.0.1。
- 验证：`bun test` 653 pass / 0 fail，`bun run typecheck`，Rust 5 pass，`cargo fmt --check`。安装版窗口经 WebView2 调试端口（只对测试壳设环境变量）+ WM_CLOSE + 窗口消息填文件夹对话框：四页面中文 / 深浅色、窗口内 SSE 与 12 秒静默流式、HTTP 页面原生命令全被 ACL 拒绝、端口冲突重试 / 退出、导入对话框、从备份恢复、209 字符数据目录 + sharp 缩图、断网启动（测试壳设不可达代理）。真机：b11146 CUDA 下载中 / 解压中关窗、27B 模型 GPU 加载中关窗（显存回基线）后重开加载流式；0.0.0 → 0.0.1 升级、强杀安装后回装 0.0.0、再升级、卸载，数据字节不变。结果详见 `docs/windows-desktop.md` 第三次接续。
- 剩余：干净 Windows（无开发工具 / 无 WebView2 bootstrapper 实测）、无 NVIDIA 的 CPU 路径与旧 CPU 指令集下限——本机无 Windows Sandbox，需用户试用。中断安装时写到哪些文件未逐一核对。gui-1 有一次无输出超时，重跑通过，原因未查。
- 决定 / 坑：`tauri build` 会重写 `src-tauri/Cargo.lock` 并去掉 `pre-commit:allow` 注释，构建后 `git checkout src-tauri/Cargo.lock`（改包版本时只改那一行）。`desktop:build` 从 HEAD 的 worktree 构建 Nuxt，服务端改动要先提交。Windows PowerShell 5 读无 BOM 的 .ps1 会乱码中文。文件夹对话框底部控件在 UIA 中只是 Pane，用 WM_SETTEXT / BM_CLICK。导航拒绝测试会把外链交给系统浏览器。
- 包：`dist/desktop/llama-web_0.0.1_x64-5-2-setup.exe`（未签名、未发布），SHA256 在桌面记录。
- 清理：上两轮残留目录已删；本轮测试安装 / 数据 / 应用本地目录（EBWebView、rc）已删，无遗留进程。`.cache/gui-*` 脚本、截图、日志和本地包有意保留。
- 下一步：Windows 套壳试用关口——用户安装试用并确认后，另开会话执行 5-3（Opus 5.5）。不做 Release / Mac。

---

## 2026-10-02 · 工作包 5-2（接续，仍部分完成） · Codex
- 完成：旧 data 导入 v2 阶段标记、完整备份摘要、可重复恢复、旧标记兼容、中文恢复入口；跨系统模型路径 / linked run / backup 拒绝。只读安装资源改用短运行缓存原子复制（完整摘要认领、异常暂存清理），未换技术栈 / 配置结构 / 调度规则；plan 两项继续未勾选。
- 验证：标准 `bun test` 652 pass / 0 fail（43 文件，无 skip）；`bun run typecheck`、`cargo check --locked` 通过，Rust 4 pass；`bun run desktop:build` 和后续 `bun x tauri build --bundles nsis` 通过。导入 11 项含真实强杀复制进程后恢复 / 恢复再次中断 / 篡改拒绝。
- 安装：最终包中文空格目录、PATH 无开发工具时内置 Bun、四页面 HTTP 200、动态 SSE、假上游静默 12 秒、假模型切换 / 回退、加载中强杀 / 重开、前后同为 0.0.0 的本地构建覆盖 / 回装及卸载保留构造配置 / key / 模型引用通过。未知 HTTP 200 占端口不被认领，释放后 private ready / shutdown 通过；未点 GUI 重试。
- 真机：最终候选包两个真实文本 GGUF 的 NVIDIA 加载 / 流式 / 切换、官方 b11140 CUDA 下载校验 / 解压后回退重载和流式通过；只读安装 ACL 下短缓存启动、官方 b11140 CPU / 0 GPU 层真实流式通过（本机仍有 NVIDIA）。真实 settings 仅只读定位路径，夹具配置自行构造，无真实 secrets / Cloudflare 读取或修改。
- 剩余：WebView 可见页面 / 深浅色 / 窗口内长请求与 SSE；GUI 冲突 / 重试、导入选择 / 恢复按钮；正常关窗时真实加载 / 下载 / 解压中止；无开发工具 / 无 NVIDIA 的干净环境、旧 CPU 指令集下限；不同版本号升级 / 故障安装回退、极深自定义数据路径。继续 5-2，不得进入 5-3 / Mac；建议导入恢复 / 运行缓存独立复审（未派发）。
- 决定 / 坑：Bun 1.3.14 模块加载在 write-denied ACL 上报 EPERM，普通读取成功；字节流复制到 data/run/desktop 的短摘要目录后解决。Windows 原生 sharp DLL 对过长路径失败，目录内仍核对完整摘要；缓存按包保留，导入不复制 run。NSIS `/D=` 必须为未加引号的最后参数，参数数组在 Bun 上要 windowsVerbatimArguments；静默默认卸载保留数据，GUI「删除应用数据」选项会删除默认目录。
- 包：`dist/desktop/llama-web_0.0.0_x64-5-2-setup.exe`，0.0.0、未签名、未发布；SHA256 与完整结果见 `docs/windows-desktop.md`。旧本地包留作测试回装。
- 清理：自有壳 / Bun / llama-server、安装与测试端口已收回，ACL 与本轮 NSIS 安装位置改动已恢复，临时 worktree 已清。CPU 验收脚本功能通过但收尾 rmSync 报 EACCES、退出 1；Native 递归 / 逐文件删除又被自动审批拒绝（仅 blocked by policy）。旧临时构建 / 夹具、首次安装失败夹具、CPU 残目录及探针 / 路径定位信息保留在忽略目录，不绕过审批；具体位置在 `.cache/desktop-5-2-continuation-resources.json`。未干预用户实例。
- 下一步：接续 5-2（Opus 5.5），先按剩余和桌面记录补人工窗口 / 干净机等验收。完成后交包停下等用户安装试用确认，仍不做 5-3 / Release / Mac。

---

## 2026-10-02 · 工作包 5-2（部分完成，需接续） · Codex
- 完成：Tauri 2 薄壳、固定 Bun + 完整 Nuxt 产物、stdin/stdout 私有 ready/shutdown（本次 UUID / PID）、单实例、15 秒退出与 Job Object、HTTP 页面无原生权限、导航限制、启动页重试 / 退出；显式旧 data 备份复制；本地 Windows x64 NSIS 包 0.0.0（未签名、未发布）。详细记录 `docs/windows-desktop.md`；plan 两项均未勾选。
- 用户确认：允许安装 Rust MSVC、Visual Studio C++ Build Tools / SDK 和项目 Tauri 构建依赖；工具安装完成。用户按 Escape 停止电脑操作后，不再调用窗口自动化，本轮结束。
- 验证：标准 `bun test` 643 pass / 0 fail（43 文件，无 skip）、`bun run typecheck`、`cargo check --locked`、Rust 3 项测试、隔离 Nuxt 构建 / Tauri debug / NSIS 构建通过；打包 Bun + sharp 输出 200×133 JPEG。调试壳中文首次向导、实时连接指示、重复启动只留原壳 / Bun、关主窗口后端口释放通过；NSIS 中文空格目录安装与卸载退出码 0。安装版已启动但页面未继续确认。
- 剩余：安装版页面 / 深浅色 / 长请求 / 动态 SSE、冲突 / 重试、真实模型流式 / 切换 / 回退、CPU 和无开发工具干净环境、只读资源、加载 / 下载 / 解压中关闭、强杀恢复、覆盖升级 / 回退保留数据、导入 GUI / 跨系统路径 / 中断恢复；不得声明 5-2 完成或进入 5-3。未运行 GPU、真实配置 / secrets / Cloudflare、Mac。
- 决定 / 坑：Bun 1.3.14、Rust 1.99.0、Tauri CLI 2.12.1；默认数据目录来自系统 API（固定 app identifier），绝对 LLAMA_WEB_DATA 可覆盖。首次数据目录先选择开始 / 复制旧 data；导入有完整备份和中断标记，硬杀后的恢复引导仍未完善。Bun license 文件名是 LICENSE.md；Nitro 默认 es2019 不支持 entry 顶层 await，使用同步监听 + 异步失败清理。
- 清理：自有壳 / Bun / 安装测试进程已停，测试安装已卸载，后来临时工作树全清；首次失败构建长路径目录残留（递归删除被自动审批拒绝，只返回 blocked by policy），.cache 测试夹具 / 日志也保留。未干预用户实例。dist/desktop 本地包与构建缓存保留，SHA256 在桌面记录。
- 下一步：另开会话接续 5-2，推荐 Opus 5.5；先读剩余与桌面记录，完成未测项、修正导入恢复 / 文案并安全清理本轮残留，再提交推送；完成后交包停下等用户安装试用，不做 5-3 或 Mac。

---
## 2026-10-02 · 工作包 5-1（跨平台兼容基础） · Codex
- 完成：plan 5-1 三项打勾；platform / 资产选择、zip / tar.gz / tgz 安装、可选 cudart / chmod / 摘要验证、解压取消 / 时限 / 越界检查；Windows 杀树与非 Windows 独立进程组 TERM → 有限等待 → KILL；可信实际路径 / birth / PGID 残留检查及配置加载前数据目录互斥。接口、迁移与边界见 `docs/platform-foundation.md`。
- 用户确认：settings v4 新增 `llamacpp.acceleration`（auto / cuda / cpu / metal）；旧配置迁移为 cuda，原参数 / current 保留，新配置 auto。JsonStore 备份旧 settings；PID v2 先备份 v1 原始字节，备份失败不覆盖，退出取消身份探测。新 runtime 按 OS / arch / acceleration 隔离；旧平铺 Windows CUDA 目录保留供加载 / 回退。
- 验证：命令进程 PATH 加入已安装 Git 的 bin 后，标准 `bun test` 638 pass / 0 fail（41 文件，无 skip）；`bun run typecheck` 通过。隔离 worktree 独立 `bun install --frozen-lockfile` 后 `bun run build` 通过（现有 Vue package exports 弃用告警）；没有构建或替换主目录 `.output`。
- 构建产物冒烟：临时 v3 配置、假模型 / Bun 编译假 llama-server，旧目录加载、迁移备份、CMD 预览、首页 200、/v1 转发、SSE、第二实例拒绝、硬杀父进程后子进程退出、死 owner 锁恢复通过。初次夹具漏传 profile 已修；真实发现服务内同步 PowerShell 身份探测超时，改为异步有界可取消并补 Bun.serve 回归后通过。
- 未运行：浏览器、真实模型 / GPU 推理、Mac 构建或真机（进程、sharp、Metal / CPU 均未验证）、真实 Cloudflare、大型运行库下载安装。仅只读 NVIDIA 探测，无真实配置 / secrets 读取或修改，无新依赖；没有桌面壳、安装包或 Release。Mac 分支为构造测试，不能声明 Mac 已支持。
- 决定 / 坑：改 acceleration 须重启；未知 NVIDIA 不自动猜 CUDA，可显式选择。无采样隐藏 GPU 卡片，Mac 提示在设置页，命令预览随平台 shell 变化。旧 PID 无 birth 跳过；实际路径 / 身份不明或 PID 复用时不杀。锁 owner 活着（含疑似复用）不抢；极短持有 guard / 写 owner 窗口被硬杀或锁损坏会保守拒绝，确认全部实例退出后才能人工处理。升级前退出没有锁协议的旧程序。
- 剩余：5-1 范围无；Mac 真机验收留后续。CR-009 解压生命周期已补齐；CR-007 成对写入硬杀恢复、CR-010 混合日志与 CR-013 历史仍保留，不重写历史。可另做独立复审；本地候选缺 runtime_identity，未冒充隔离复审、未派发或消耗其额度。
- 清理：本轮专用临时构建 worktree、冒烟脚本 / 数据与自有进程已清理；未干预用户已有实例。
- 下一步：另开会话执行 5-2，推荐 Opus 5.5；交付本地 Windows 测试安装包后停下等用户试用，不自动继续 5-3 或 Mac。

---

## 2026-10-02 · 发布与 Windows 套壳规划（仅文档） · Codex
- 完成：在 plan 新增阶段 5，写明现有平台限制、Tauri 2 + 内置 Bun + 完整 Nuxt 产物的拟议方案、兼容基础 / Windows 本地安装包 / Windows Release 的分包顺序、生命周期与安装验收、Mac 后续路线。同步 guide 5-1～5-3 卡片和 AGENTS 的停点规则；6 个新实现任务全部未打勾，既有任务状态未变。
- 用户最新要求：先做兼容，再把 Windows 套壳做出来；不直接往下做。5-2 交付本地 Windows 测试包后必须停下来等用户试用确认；Mac 套壳 / 发包须用户另行启动。本会话只写 plan，没有开始实现或创建 Release。
- 研究：只读核对项目 Releases（尚无发布）、llama.cpp nightly 指针 b11146 的三平台资产、cloudflared 2026.9.3 的 Darwin 资产及 Tauri / Bun / sharp 官方文档；链接在 plan。
- 验证：`bun test` 564 pass / 51 skip / 0 fail（当前 PATH 缺 sh）；仅为补齐跳过项，在该命令进程的 PATH 加入已安装 Git 的 bin 后运行 `bun test tests/platform/pre-commit.test.ts`，51 pass / 0 fail。`bun run typecheck` 通过。Bun 内联文档检查：ID 唯一、内部锚点与容器闭合有效，6 个新任务未完成、原任务不变；初次任务比较被 HTML 注释及换行差异误报，修正检查后通过。`git diff --check` 通过。
- 未运行：build、浏览器、GPU / 真实模型、Mac 真机、安装包；未读取 secrets、未修改 Cloudflare、未安装工具。只修改 plan / guide / handoff / AGENTS，无临时文件或常驻进程。
- 剩余：5-1～5-3 均未实现；选型需在 5-2 最小验证。许可证、签名、正式版本号待发布前确定；阶段 4 已披露边界不抹去（解压时限纳入 5-1，其余按 plan 发布清单评估）。
- 下一步：另开会话执行 5-1（跨平台兼容基础）；完成后再开 5-2，不在同一会话连续执行。

---

## 2026-10-02 · 阶段 4 第四轮复审意见处理（docs/reviews/stage-4-codex-r4.md） · Opus 5.5
- 完成：CR-027～CR-029 全部成立并已修复，CR-025 / CR-018 的「测试不经过生产接线」一并补上。pre-commit：引号加入反引号，声明排除只管不带引号的值，名称后的 TS 类型标注、名称行开串的分行值也拦（027）。Cloudflare 任务加服务端版本号 `{ boot, seq }`（`CloudflareSetup.view()`、快照 `cloudflareRev`、5 个接口都返回 `view()`），前端按版本取新、不再看连接状态（028）。hook 测试一次一跑 + 显式 30 秒预算，hook 加无进程预筛（029）。`server/service/cloudflare-hooks.ts`：端口守卫与成对保存的接线，context 与 `tests/service/` 共用。
- 验证：标准 `bun test`（不加超时参数，sh 在 PATH 上）两次均 615 通过 / 0 失败；`bun run typecheck` 0；新测试对旧代码的反证：旧 composable 3 条交错用例失败、端口接线改回读缓存后接线测试失败。构建：在临时 worktree 里 `bun run build` 通过，构建产物 + 临时数据目录（自动更新关）冒烟：`/api/cloudflare`、`/api/state`、`/api/stream`、dismiss 均带 rev，首页 200；已停已删。**没运行**：浏览器、真实 Cloudflare、真机。
- 剩余：同上一条（CR-007 两次写之间被杀、CR-009 解压无时限、CR-010 混合日志待确认、CR-013 历史）。
- 决定 / 坑：**用户在跑 start.bat 时不要在主目录 `bun run build`**：本次在主目录构建时 sharp 的 .node 被运行中的实例占用，构建先清空了 `.output` 再失败，运行实例的页面资源 500。已在临时 worktree 按运行实例对应的提交（1d5c7a6，靠资源哈希确认）重建并放回，页面恢复；运行实例的 `/api/state` 因缺文件期间首次加载失败被缓存，仍 500（界面不用它），重启实例即恢复。构建验证一律放临时 worktree。worktree 用 junction 共享 node_modules 会让 Nuxt 构建报错，要在 worktree 里 `bun install`。
- 下一步：没有新的工作包；第五轮复审可选。

## 2026-10-02 · 阶段 4 第三轮复审意见处理（docs/reviews/stage-4-codex-r3.md） · Sonnet 5.5
- 完成：CR-023～CR-026 共 4 条逐条核实，**全部成立并已修复**：pre-commit 用暂存文件的上一行判断分行凭据（只改值也能拦住），带引号字面量不要求数字、不带引号的值要求含数字且 `const/let/var` 声明和函数调用不算（023、024）；Cloudflare 任务的端口守卫先读磁盘再比较（025）；live 断线后 HTTP 结果重新生效、重连快照再接管（026）。
- 验证：`bun test` 571 通过 / 0 失败（39 个文件，sh 在 PATH 上，16 条 hook 测试全部执行）；`bun run typecheck` 退出码 0。**没运行**：build、浏览器、真实 Cloudflare、真机。
- 剩余：同上一条（CR-007 两次写之间被杀、CR-009 解压无时限、CR-010 混合日志待确认、CR-013 历史、`context` 接线无集成测试）。pre-commit 的已知误报边界：非声明语句里「属性 = 含数字的长标识符」，加 `pre-commit:allow`。
- 决定 / 坑：pre-commit 为查上一行对每个「像值」的新增行调用一次 `git show` + `sed`（仅这类行）。
- 下一步：没有新的工作包；第四轮复审可选。

---

## 2026-10-02 · 阶段 4 复审意见处理（docs/reviews/stage-4-codex-r2.md） · Sonnet 5.5
- 完成：复审 CR-014～CR-022 共 9 条逐条核实，**全部成立并已修复**（处理结果写在复审文件里）：pre-commit 分行赋值 / `CF_*` 名称 / 要求值含数字避免误报（014、015）；`mergeIngress` 按主机名 + 路径的实际命中验证，带 path 的通配规则不再算宽泛规则（016）；ingress 步骤用 `configHash` / `resultHash` 区分「仍是预览版本」与「恰好是预期结果」，混合则 changed（017）；`localPort` 钩子，端口变了就停（018）；`Hold` 退出时无论成败都对账一次（019）；`abortable` 预取消不留未处理拒绝、已取消不发请求（020）；收到 live 快照后 job 只由 live 更新（021）；DNS 恢复比较 `proxied`，被改过则拒绝清理并保留任务（022）。
- 验证：`bun test` 566 通过 / 0 失败（39 个文件，sh 在 PATH 上，pre-commit 测试全部执行；新增 composable、Hold、预取消、分行凭据、路径命中、端口、代理开关等约 11 条）；`bun run typecheck` 退出码 0。**没运行**：`bun run build`、浏览器、真实 Cloudflare、真机。
- 剩余：CR-007 两次写入之间进程被杀的恢复未做；CR-009 解压无取消 / 时限；CR-010 匿名注册 + 带索引注销的混合日志格式待确认；CR-013 已推送历史里的真实隧道名由用户决定；`context` 的 Hold / 保存接线没有集成测试；没有浏览器 / 真实 Cloudflare 验证。
- 决定 / 坑：`mergeIngress` 的语义见函数注释（新规则在会遮蔽它的无 path 规则之前、带 path 规则之后；自己的规则被宽泛规则遮蔽时移到前面）。`SetupPlan.resultHash`、`SetupHooks.localPort`、`i18n` 的 `changed-*` 新增，向后兼容。`tests/app/` 里用 `mock.module` 替代 Nuxt 的 `~~` 别名。pre-commit 现在对每个新增行多启动几次 grep，大提交会更慢（本机一次提交约 1 分钟）。
- 下一步：没有新的工作包；等 Codex 第三轮复审（可选）。

---

## 2026-10-02 · 阶段 4 审查意见处理（docs/reviews/stage-4-codex.md） · Sonnet 5.5
- 完成：13 条逐条对照代码核实，**12 条成立并已修复，CR-006 用户选方案 A（保持现状，失败卡片补恢复提示），0 条不成立**；每条的处理结果写在审查文件里。没有勾选 plan 任务。修复：pre-commit 识别隧道 token / API token 赋值（CR-001）；Cloudflare 放弃时恢复被改指的 DNS（002）；沿用隧道时保留完整远程 config（003）；ingress 合并保持优先级（004）；ingress 写入前校验配置未变、识别丢响应的自身写入（005）；secrets + settings 成对写入失败回滚、成功后才切换托管（007，`core/write-pair.ts`）；cloudflared 准备可取消、关闭 / 换 token 时等待（008）；更新 / 下载 HTTP 时限与关机取消（009，`NetOptions`、`Updater.stop()`）；Unregistered 日志按 connIndex 计数（010）；pid 登记失败不留 child（011）；Cloudflare 任务进入 live 快照（012）；交接里的真实隧道名改为泛化描述（013）。
- 验证：`bun test` 555 通过 / 0 失败（新增约 25 条，含 sh 下的 pre-commit 测试）；`bun run typecheck` 通过（退出码 0）。**没运行**：`bun run build`、浏览器里的「运行中刷新 / 另一标签页」场景（只有单测）、真实 Cloudflare（002/003/005 只有 FakeCloudflare）、真机。
- 剩余：CR-006 已按方案 A 处理（不自动认领；`tunnel-exists` / `dns-appeared` / `ingress-changed` 失败时提示「放弃后重新预览并确认」）。CR-003 真实 API 对缺省字段的语义未核实（现在原样回传，不依赖它）。CR-007：进程恰好在两次写入之间被杀的恢复未做。CR-013：已推送的历史提交里仍有真实隧道名，是否改写历史由用户决定。
- 决定 / 坑：`mergeIngress` 顺序变了（原位替换 / 插在会遮蔽它的规则之前），旧测试里「新规则在最前」的断言已改。`TunnelManager` 的 teardown 会等 prepare 结束，自定义 prepare 需要响应 `net.signal`。`SetupPlan` 新增 `configHash`，`SetupJob.created` 新增 `dnsRestore`，`StateDoc` 新增 `cloudflare`（均向后兼容）。
- 下一步：没有新的工作包（开发共 4 个阶段，阶段 4 已全部完成）。等 Codex 复审。

---

## 2026-10-02 · 工作包 4-6（接续：阶段 4 更新 / 回退验收） · Opus 5.5
- 完成：plan 阶段 4「真机试用」打勾，阶段 4 任务全部完成。没有改代码。
- 验证：`bun run build`、`bun test` 532 通过、`bun run typecheck` 通过。真机（临时数据目录：复制 settings.json（关公网 / 托管，端口 5099，模型端口 7300–7399）、models.json、templates/，不复制 secrets.json；已停已删，GPU 回到基线以下）：用 `installBuild` 真实下载安装旧版 b11140（CUDA 13.4，55 秒）并设为当前 → 启动构建产物，先监听、后台检查到官方最新 b11146 → 自动下载、校验、解压、设为当前（`ready / updated / from b11140`，约 30 秒）→ `POST /api/llamacpp/current {tag:b11140}` 回退（`switched`，settings.json 已写 b11140）→ Qwen3.8-27B 加载 43 秒 ready，对话返回 `ok`；系统进程表里 llama-server 的路径在 b11140 目录，该 exe `--version` 为 build 11140；`/api/llamacpp` 显示 b11140 current + inUse → 卸载、停止。用户真实 data 未改动（仍是 b11146）。
- 剩余：无（阶段 4 工作包全部完成）。**没测**：这次回退走的是接口，不是界面按钮（界面确认框在 4-2 用假目录验证过）；真实 cloudflared 配置行解析仍只有单测（见上一条）。
- 决定 / 坑：临时数据目录必须连 `data/templates/` 一起复制，否则带自定义模板的模型 `chat template not found` → failed，修好后要 `POST /api/models/:id/retry`（failed 不会被下一个请求自动重试，符合设计）。官方「最新」指针 2026-10-02 仍是 b11146（Release 列表里已有 b113xx，但指针没动）。
- 下一步：阶段关口 4（用户试用 → Codex 审查阶段 4 → 处理意见）。

---

## 2026-10-01 · 工作包 4-6（未完：阶段 4 更新 / 回退验收） · Opus 5.5
- 完成：plan 阶段 4「公网模块合并 + 引导」。`SettingsPublicAccess.vue`（未开启 / 引导 / 总览），`PublicWizard`（端口 → key → 方式 → 一键：API token / 地址 / 预览执行（`PublicCfRun`），或手动：教程 / 粘贴 token → 连接），`PublicOverview`、`PublicStatus`、`PublicAddresses`（地址 + 检测）、`PublicKeys`（原 SettingsKeys）、`PublicAdvanced`；`useCloudflareSetup` 共享 4-5 状态。删掉 SettingsPublic / SettingsTunnel / SettingsCloudflare。settings v3：`public.wizard`（`cleanWizard`，迁移）。`core/public-check.ts` + `POST /api/public/check`。`tunnel.ts`：`ingressHostnames` 从 cloudflared 的 `Updated to new configuration` 行取指向本机端口的主机名 → `TunnelInfo.hostnames`。`SettingsDoc.public.cloudflared`。README 公网一节改写。
- 验证：`bun test` 532 通过、`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录 + 假 Cloudflare（已停已删）在内置浏览器走完两条分支、再加一个地址、关闭、保存进度后刷新继续、v2→v3 真实文件迁移、错端口 / 错 token 被拒、深色 + 375px 无横向滚动、日志无 token / key。用户在真实环境（start.bat）远端跑通。
- 剩余：**阶段 4 验收「打开时自动下载新版 + 回退后用旧版本加载真实模型」仍未做**（占 GPU、下载约 1 GB，在临时数据目录里做：先装比 b11146 旧的真实版本 → 启动让更新器下载 b11146 → 回退 → 真实模型加载确认版本）。做完后给出阶段 4 验收结果表，再勾 plan「真机试用」。**没测**：真实 cloudflared 的配置行解析（只有按真实格式写的假进程单测；用户远端跑通但没核对地址列表）。
- 决定 / 坑：`useSettings.save` 正在保存时会拒绝第二次保存——引导里先保存再切步骤（`go()`），连接步骤等前一次保存结束再打开入口。Bun 的 fetch 把域名解析失败报成 `ConnectionRefused`，检测失败时再 `dns.lookup` 区分。Bun 下 `AbortSignal.timeout` 不算挂起任务，测试会卡死，用自己的定时器。`bun run dev` 下没有公网入口和隧道 → 530（用户踩到，已加醒目提示）；用户的 dev 服务器热重载时把真实 settings.json 迁到了 v3（有备份）。TaskStop 后 bun 子进程仍在，按 PID `taskkill /T`。
- 下一步：接续 4-6 剩余（阶段 4 更新 / 回退验收），之后阶段关口 4。

---

## 2026-10-01 · 工作包 4-5 · Opus 5.5
- 完成：plan 阶段 4「一键建隧道」。`server/core/cloudflare.ts`：`CfClient`（可注入 fetch，token 只放 Authorization 头）、`inspect`（校验用户 / 账号 token，列 zone，探测 Tunnel / DNS / Zone 读权限，缺哪项指出来；只有 active zone 可用）、`planSetup`（同名隧道 / CNAME 指向的隧道 / 当前托管隧道 → 选择；入口规则合并保留其他主机名；A/AAAA 或多条记录 → blocked；fingerprint）、`CloudflareSetup`（tunnel → ingress → dns → token → save，失败停在该步，重试从失败步继续，放弃只删本次新建的隧道 / DNS）。secrets.json → v3（`cloudflareToken`，迁移）。接口 `/api/cloudflare`、`/token`、`/zones`、`/preview`、`/apply`、`/retry`、`/cleanup`、`/dismiss`。界面 `SettingsCloudflare.vue`（token、建 token / 域名接入的说明、选域名、预览、确认框、步骤结果）。真机后追加：默认沿用正在托管的隧道（由隧道 token 解出 ID，`tunnelIdOf`），换域名 = 给它加一个地址；隧道名移入「高级」。README 公网一节重写（先决条件 / 方式 A 一键 / 方式 B 手动）。
- 验证：`bun test` 519 通过（新增 cloudflare 29、keys 3、tunnel 1）；`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录 + 假 Cloudflare（HTTP 包一层 fixture，已停已删）在内置浏览器：错 token 拒绝、好 token 列 zone、冲突选择、注入 DNS 失败 → 重试成功、403 失败 → 放弃只删新隧道、A 记录 blocked、手机宽度 + 深色无横向滚动；日志 / 接口无 token。真机（用户自己在界面操作）：第一个域名经隧道带 key 200、无 key 401、吊销 401、`/`、`/api/state` 404；第二个域名 401（可达）。
- 剩余：阶段 4 验收里**仍未验证**：真实的自动更新下载、真实模型下的回退（放进 4-6）。**没测**：「默认沿用当前隧道」在真实账号上的执行（只有单测 + 真实账号的只读预览）。
- 决定 / 坑：用户公司网络打不开第一个域名（不是程序问题；目标服务在别的机器上，本机测不到）。用户第二次建隧道时新建了隧道 llama-web 并替换了托管 token（多半是在修复生效前跑的），所以**第一个域名现在 530**（CNAME 仍指向无连接的旧隧道）；用新界面对该域名再跑一次即可改指（会改 DNS，先问用户），或在后台删掉旧隧道 / 记录。Cloudflare 不提供免费域名、API 不能代注册。测试用 `LLAMA_WEB_CLOUDFLARE_API` 指向假 Cloudflare。界面目前四张公网卡片并列，用户认为太复杂 → 4-6。
- 下一步：工作包 4-6「公网模块合并 + 引导 + 阶段 4 验收」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。

---

## 2026-10-01 · 工作包 4-4（含阶段 4 验收） · Opus 5.5
- 完成：plan 阶段 4「隧道托管」。`server/core/tunnel.ts`：`extractToken`（裸 token 或整条命令）、打码 / `redact`；查找 cloudflared（PATH + 常见安装位置）→ 复制到 `data/runtime/cloudflared/`，没有就从官方 Release 下载并校验 SHA-256；`TunnelManager`（token 走环境变量 `TUNNEL_TOKEN`，输出逐行脱敏，识别 Registered / Unregistered tunnel connection → 已连通；意外退出退避重试，token 无效不重试；pid 记入 pids.json，停止杀进程树）。仅在「公网入口监听中 + 已存 token + 托管开关开」时运行。settings.json → v2（删 `tunnelName`，加 `public.tunnelEnabled`，迁移函数）；secrets.json → v2（加 `tunnelToken`）。接口 `/api/tunnel/token`、`/api/tunnel/retry`；快照 `tunnel`、事件 `kind:'tunnel'`。界面：设置页「Cloudflare 隧道」卡片 + 带 SVG 示意图的分步指引；公网入口卡片去掉隧道名 / DNS 命令。README 隧道一节改写（并更正 secrets.json 是明文而非哈希）。
- 验证：`bun test` 全部通过（新增 tunnel 21 条含真实子进程、keys / settings / residue 若干）；`bun run typecheck`、`bun run build` 通过。真机（临时数据目录，端口 5097 / 18090，已停已删，GPU 回到基线）：已装 cloudflared 2026.5.0 被复制并运行；伪造 token 连不上时显示「正在连接」+ 最近报错；用户自己的 token：状态已连通（4 条连接）；经隧道无 key / 错 key / 吊销后的 key → 401，带 key 的 /v1/models 200，/api/state、/api/keys、/settings、/upstream、/ → 404；带 key 流式对话触发 Qwen3.8-27B 加载（41 秒）并出流；请求记录 source=public + key 名；token / key 未出现在日志、事件、server 输出；真实 settings.json 副本迁移到 v2 且生成备份；`git add -f data/x` 被 pre-commit 拒绝。
- 剩余：阶段 4 验收里**未验证**两项：官方出新版时的自动下载安装（当前官方最新仍是 b11146，没有可下载的）、真实模型下的版本回退（只有一个版本；回退逻辑在 4-2 用假目录验证过）。**没测**：cloudflared 下载路径的真实网络（只有假 fetch 的单测；本机已装）；Windows 服务形式的 cloudflared 与本隧道并存；深色模式 / 手机宽度下的新卡片；`nuxt dev` 下（只会显示「开发模式没有公网入口」）。
- 决定 / 坑：与 4-3 记录的差异——用 `TUNNEL_TOKEN` 环境变量代替 `--token`（不进进程列表）；已装的 cloudflared 复制到 `data/runtime/cloudflared/` 再运行，这样残留清理只杀 runtime 下进程的规则同样覆盖隧道。真实 cloudflared 遇到不存在的隧道 token 不会退出而是一直内部重试，所以界面显示「正在连接」+ 最近报错，而不是错误卡片。`dnsCommand` / `routeDnsCommand` / `bad-tunnel` 已删。Windows 上硬杀 llama-web 时 cloudflared 随管道关闭自己退出（观察到，不依赖它）。
- 下一步：新增工作包 4-5「一键建隧道」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。真机试用发现：用户真实 data 里存的是另一条隧道的 token（已清空并关闭托管开关），域名 CNAME 指向的那条旧隧道当前无连接且入口规则仍指向测试端口 18090，4-5 里一并处理。

---

## 2026-10-01 · 工作包 4-3 · Sonnet 5.5
- 完成：plan 阶段 4 第 7–8 项。`scripts/pre-commit`（POSIX sh）：拒绝 `data/`、`secrets.json`、`.env*`，扫描新增行的 `sk-…`、32 位以上十六进制串、Bearer token（报错不打印值）；行内标记 `pre-commit:allow` 放行假值；`docs/reviews/` 不查十六进制串（引用提交哈希）。`.gitattributes` 固定该脚本为 LF（`core.autocrlf=true` 下 CRLF 会让 sh 失败）。启用：`git config core.hooksPath scripts`（每个克隆一次）。`README.md`（中文）。
- 验证：`bun test` 457 通过（新增 `tests/platform/pre-commit.test.ts` 8 条，在临时 git 仓库里真实运行脚本）；`bun run typecheck` 通过；真实仓库里 `git add -f data/settings.json` 后运行脚本被拒绝。**没运行**：`bun run build`；阶段 4 真机试用（见下）。
- 剩余：阶段 4 第 9 项「真机试用」未做。**用户要求改隧道方案**（变更记录已写）：改为设置页填隧道 token，llama-web 自动检测 / 下载 cloudflared 并 `--token` 托管，带 Cloudflare 后台分步图文指引；用户本机已装 cloudflared。该部分拆成工作包 4-4（plan 新增任务、claude-guide 新增卡片）。
- 决定 / 坑：README 的隧道一节描述的是旧流程（手动 DNS 命令 + config.yml），4-4 要改写。设置页现有「需要手动执行的命令」「ingress 提示」在 4-4 一并替换；`dnsCommand` 相关代码和测试到时再处理。
- 下一步：工作包 4-4（Opus 5.5，含阶段 4 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 4-2 · Opus 5.5
- 完成：plan 阶段 4 第 4–6 项。`server/core/updater.ts`（`Updater`）：启动后台（等残留清理完）检查一次：采用已装版本 → 查官方最新（nightly-tag）→ 没装就下载 CUDA 构建 + cudart、SHA-256 校验、在 `.tmp-` 里解压、改名成版本目录 → 设为当前 → 清理旧版本。`llamacpp.ts` 拆出 `installBuild` / `clearLeftovers`，删掉 `ensureRuntime`。状态 `RuntimeStatus.ready.note`（latest / updated / pinned / auto-off / switched）、`error.using`（失败后继续用的版本）；事件带 `note` / `from`。接口 `GET /api/llamacpp`、`POST /api/llamacpp/current {tag}`。快照 `llamacpp.versions`（current / inUse）、`rollback`。界面：设置页「llama.cpp 版本」卡片（状态、版本列表、切换 / 回退）；全局确认框 `LlamacppSwitchModal`；失败卡片在「当前是最新安装的版本且有旧版本」时提示回退（oom / 文件 / 端口 / 参数 / 需更新版本这几类不提示）。
- 验证：`bun test` 449 通过（新增 updater 18 条，含 Windows 上目录被别的进程占用时整体保留；live 1 条；fake GitHub 移到 `tests/fixtures/fake-github.ts`）；`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录（端口 5096，已停已删）：真实 GitHub 查询到最新 b11146（已放假目录，未下载）→ 手动选的 b11000 保持当前（pinned）、第 3 个旧版本被清理、`.tmp-` 残留被清除；切换接口成功 / 未安装 404 / 非法 400 / 跨站 403；内置浏览器里假模型（空 exe → spawn-failed）失败卡片出现「回退到 b11000」，确认框 → 切换成功，顶栏和总览更新，提示消失；设置页卡片正常，控制台无错误。**没测**：真实下载一个新版本并替换（当前没有更新的官方版本，下载路径只有单测 + 1-6 的首次下载）；真实 llama-server 运行时其版本目录不被删（单测覆盖）；网络失败时的界面文字（单测覆盖状态）；深色模式下的新卡片。
- 剩余：无。
- 决定 / 坑：
  - 只有「下载了新版本」才设为当前；回退后的选择在下次打开时保持，直到官方发布更新的版本（plan 变更记录已写）。下载期间手动切换的版本也不会被覆盖。
  - 保留：最新 `keepVersions` 个（至少 2）∪ 当前 ∪ 正在运行 / 启动中的进程所在目录，所以可能临时多于 2 个。删除前先改名为 `.del-…`，改名失败（被占用）就整体保留。
  - 切换版本不重启正在运行的模型；卸载后再加载才用新版本（确认框里有说明）。
  - `autoUpdate` / `keepVersions` / `cudaRuntime` 仍只能手改 settings.json（界面只读显示）。
  - 新建的 models.json 不会被文件监听发现（watcher 只盯启动时已存在的文件），需要重启；不是本工作包改的。Bash 后台任务被 TaskStop 后 bun 子进程可能还活着，按端口查 PID 结束。
- 下一步：工作包 4-3（Sonnet 5.5，含阶段 4 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 4-1 · Opus 5.5
- 完成：plan 阶段 4 第 1–3 项。`server/core/public-entry.ts`：`handlePublic`（先查路径：只有 `/v1/*`，且不含 `%2e` `%2f` `%5c` `\`，其余 404 且不看 key；再查 `Authorization: Bearer`，失败统一 401 + `WWW-Authenticate`；通过后在进程内调 `proxy.handleV1(req, { ip, keyName })`；内部异常给通用 500）；`PublicListener`（只绑 127.0.0.1，`enabled` / `port` 变化才重启监听，绑定失败显示原因并在下次保存时重试；没挂监听实现时为 unavailable）。`server/core/keys.ts`：`sk-` + 32 字节随机、sha256 + timingSafeEqual 遍历全部 key、吊销保留在列表、名称在未吊销 key 中唯一、打码 `sk-AbCd…wxYz`。`data/secrets.json`（version 1，JsonStore 原子写 + 备份，读坏了按「没有 key」处理）。接口 `/api/keys`（GET 打码列表、POST 新建返回一次明文、`POST /:id/reveal`、`POST /:id/revoke`）。设置：`public` 段（开关、端口、域名、隧道名），`SettingsDoc.public` 带监听状态、`dnsCommand`、可用 key 数。界面：设置页「公网入口」「API key」两张卡片（吊销用确认框）。
- 验证：`bun test` 432 通过（新增 keys 20、public-entry 22（含真实 socket 端到端）、settings-admin 6）；`bun run typecheck`、`bun run build` 通过。构建产物实测（临时数据目录、主端口 5098、公网 18089、关闭自动下载、不加载模型，已停已删）：无 key / 错 key → 401，有效 key `/v1/models` 200；`/`、`/settings`、`/api/state|stream|keys|settings`、`/upstream/x/props`、`/_nuxt/`、`/favicon.ico`、`/v1`、`/v1/%2e%2e/...`、`--path-as-is /v1/../api/state` 带 key GET/POST 全部 404；本机局域网地址连 18089 被拒（只监听 127.0.0.1）；吊销后立即 401；请求记录 `source: public` + key 名，key 明文未出现在请求 / 事件日志和控制台；关闭开关后端口释放；跨站 POST 吊销 403。浏览器里新建 / 查看 / 吊销确认框可用。**没测**：真实 Cloudflare 隧道（4-3 验收）；经公网入口触发真实模型加载与流式（只用了假上游的单测）；开发模式。
- 剩余：无。
- 决定 / 坑：
  - **来源识别改为进程内传参**（用户确认，plan 已改「来源识别」并加变更记录），没有内部头。
  - 公网开关 / 端口**保存后立即生效**，关闭时 `stop(true)` 中断进行中的公网请求；`nuxt dev` 下没有公网入口（界面会说明）。
  - 401 不记请求记录（只有通过鉴权的请求进入 `/v1` 处理）。`allowSwitch` 仍是坑位，只存不用。
  - 从 Git Bash 用 curl 发中文 JSON 会变乱码（不是程序问题）；测试时用英文名或界面。
- 下一步：工作包 4-2（Opus 5.5）。

---

## 2026-10-01 · 阶段 3 审查意见处理 · Sonnet 5.5
- 完成：`docs/reviews/stage-3-codex.md` 6 条：CR-001/002/003/004/005 核实成立并修复，CR-006 不成立（理由见文件）。CR-001：失败卡片的输出末尾对绝对路径脱敏（`redactPaths`，在 `diagnose()` 出口）。CR-002：日志读取用 `lstat` 拒绝符号链接。CR-003：`UsageTap` 单个超大块只留末尾 keep 字节。CR-004：加载进度采样移到 `trackWeightLoad`（`load-progress.ts`），单飞、stop 后丢弃在途结果。CR-005：OOM / bad-model 规则收紧，Info / Debug 行不参与分类。
- 验证：`bun test` 387 通过（新增 errors 5、request-log 2、logs 1、load-progress 3）；`bun run typecheck` 通过。**没运行**：build、真机（本轮没有改变真机行为之外的东西，但 `trackWeightLoad` 搬了位置、错误规则收紧后没有再用真实 llama-server 复测）。
- 剩余：无。局限：错误规则对「无等级标记的普通行里同时含这些词」仍可能误判；符号链接测试在无权限的机器上会被跳过；在途 nvidia-smi 不取消（最多 3 秒）。
- 下一步：阶段 3 关口——用户确认后开始 4-1（Opus 5.5）。

---

## 2026-10-01 · 3-3 补丁：加载进度 · Sonnet 5.5
- 完成：修真机加载进度不动。原因：当前 llama.cpp（b11146）加载时几乎不输出（只有 `loading model` → `llama threadpool init` → `creating MTP draft context` → `load_model: initializing` → `llama_server: model loaded`），没有点号行，旧里程碑也匹配不上。现在：新增这几条里程碑；加载期间每秒按 GPU 显存增长 ÷ 权重文件大小（model + mmproj + draft，`LaunchPlan.weightFiles`）推进 12→90%，没有 nvidia-smi 时用时间曲线（τ=15s）；`LoadProgress.estimate()`，`trackWeightLoad`（context.ts）；只增不减，里程碑更靠前时以里程碑为准。
- 验证：`bun test`、`bun run typecheck`、`bun run build` 通过（load-progress 新增 3 条）。真机（Qwen3.8-27B，临时数据目录，已停已删）：热缓存加载 8 秒，进度 12 → 14 → 85 → 94 → ready。**没测**：冷缓存长加载（预期更平滑）；无 nvidia-smi 的机器；多 GPU（按总显存增长算）；有别的程序同时占显存时进度可能被带偏（只会提前，不会倒退，就绪后归零）。
- 剩余：无。部分卸载（-ngl 小于全部层）时显存增长小于文件大小，进度会停在中段直到里程碑。
- 下一步：阶段 3 关口，用户确认后 4-1。

---

## 2026-10-01 · 工作包 3-3（含阶段 3 验收） · Sonnet 5.5
- 完成：plan 阶段 3 第 7–9 项。`server/core/errors.ts`：按进程最后输出 + 退出码识别 oom / cuda-error / dll-missing / file-missing / unknown-arg / mmproj-mismatch / unsupported-arch / bad-model / port-in-use，认不出保留 `exited` / `timeout` / `crashed` 等原因码（顺序敏感，显存不足优先于笼统的 failed to load model）。`ModelCrashError` 现在带最后 30 行和退出码（`ModelProcess.tail?`）。快照 `instances[].failure`（kind、exitCode、tail）；`errorText` 和 `/v1` 503 报错用识别后的 kind（事件里只有 kind，不含输出）。界面 `FailureCard`（总览 + 模型卡片）：中文原因 + 建议 + 「不会自动重试」+ 最后 30 行 + 「查看完整日志」（`/logs?model=<id>` 预选模型）+ 重试。
- 验证：`bun test` 373 通过（新增 errors 22、live 1、scheduler 1）；`bun run typecheck`、`bun run build` 通过。**阶段 3 真机验收**（RTX 5090、临时数据目录、端口 5094、b11146 拷贝、Qwen3.8-27B，用完已停已删，显存回到基线约 3 GB）：
  - ctx=4000000 + f16 KV：36 秒后失败，界面「显存不足」+ 建议 + 最后 29 行（末行 `failed to allocate buffer for kv cache`），第二次请求 0.2 秒内直接 503，没有重试 → 通过。
  - 流式生成：顶栏 / 总览实时 89.0 t/s；结束后「上次：提示处理 51.6 · 生成 89.5」，llama-server 自己的 timings 为 51.55 / 89.46（另一次 676.9 / 91.8 也一致）→ 通过。
  - 外部杀掉 llama-server → `crashed` 卡片（退出码 255、30 行）；硬杀 llama-web 重启后 `/api/logs` 仍列出两次运行的模型日志，最后一行 `# llama-web: exited code=255` → 通过。
- 剩余：无。**没测**：真实环境下的未知参数 / mmproj 不匹配 / 文件缺失 / 缺 DLL（只用合成输出单测，OOM 用了真实输出）；浏览器里点「查看完整日志」后的跳转（只测了接口和链接构造）；多 GPU；手机宽度下的卡片。
- 决定 / 坑：
  - **加载进度在真实 llama-server 上基本不动**：27B 加载 ~35 秒，进度停在 3% 直到就绪（3-2 预告的风险成真，点号行没有被识别 / 没出现）。plan 里该项已勾，但真机上体验差，建议下一步按模型文件大小或显存增长估算。
  - 失败卡片的输出末尾含模型路径（只在界面，不落盘到事件）；提交内容无个人路径。
  - `pkill` 在此环境不存在；`bun run build` 会因 `.output` 被运行中的服务占用而失败，先停服务。
- 下一步：阶段 3 关口——请用户试用并确认后再开始 4-1（Opus 5.5）。

---

## 2026-10-01 · 工作包 3-2 · Sonnet 5.5
- 完成：plan 阶段 3 第 4–6 项。`server/core/speed.ts`（`SpeedMeter`）：流式时数 SSE 的 `data:` 事件（行首匹配，一次原生字节搜索，不解码）按 3 秒窗口估 t/s，结束后用响应末尾 `timings`（`UsageTap.result()` 新增 `promptPerSecond` / `predictedPerSecond`）替换；没有 timings 时用整段平均并标「估算」；非流式只取 timings。`load-progress.ts`（`LoadProgress`）：按日志里程碑（不依赖 `函数名:` 前缀）+ 权重加载的点号行（无换行，所以 `runner` 新增 `onPartial`）估算 0..99%，只增不减；进度进快照 `instances[].progress`（仅 loading），也接到流式等待加载的 `: loading N%` 心跳（`progressOf`）。`gpu.ts`（`GpuSampler`）：按 `settings.gpu.sampleSec`（≥0.5 秒）采样 `nvidia-smi`，**只在有浏览器连着 `/api/stream` 时采样**，没有 nvidia-smi 就 `available:false`（总览不显示显存卡），每 60 秒重试一次。`LiveHub` 新增 `metrics` 消息（速度 + 显存，250ms 合并、相同不推、慢读者只保留最新），连接时先发一帧。界面：总览加载进度条+百分比、运行中模型的实时 / 上次速度、显存卡；顶栏显示正在生成的 t/s。
- 验证：`bun test` 349 通过（新增 speed 10、load-progress 4、gpu 6，live +3、proxy +4、runner +1、request-log +1，并改了 live 一条断言；fake-llama-server 加了 `dots` 模式）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译的假 llama-server（会输出里程碑、无换行点号行、流式带 timings；临时数据目录、端口 5097，已停已删）在内置浏览器实测：加载中进度 20→51→86→93 并显示「加载进度约 78%」、生成中 21 t/s（顶栏同步）、结束后显示「上次：提示处理 812.3 t/s · 生成 24.9 t/s」；显存卡读到本机真实 nvidia-smi。**没测**：真实 llama-server 的日志（只用 `llama.dll` 里的字符串确认了 `loading model tensors` / `offloaded %d/%d layers` / `loaded meta data with` / `constructing llama_context` / `llama_kv_cache` / `compute buffer size` 存在；`main: model loaded`、`initializing slots` 以及点号行是否真的会出现没确认）；真实生成速度与 llama-server 自身统计对比；多 GPU；没有 nvidia-smi 的机器上的界面。
- 剩余：无。
- 决定 / 坑：
  - `metrics` 不放进 snapshot（速度每秒变化，会让快照 diff 失效）；前端从 `useLive().metrics` 读。
  - 速度只按「有 modelId 的 /v1 请求」统计；`/upstream` 不统计；streaming 请求在上游返回响应头后才算开始（`prompt` 阶段只在头已到、首 token 未到时出现）。
  - 若真实 llama-server 不打点号行，进度会在 10% → 91% 之间不动（只剩里程碑）；3-3 真机时留意，必要时改成按模型文件大小 / 显存增长估算。
  - Bash 的 heredoc 遇到中文 / 引号 / 反斜杠常整条失败：写文件用 Write 工具，改文件用 Python 脚本文件（别在 heredoc 里写 `\b` 之类转义，会被吃成控制字符）。
- 下一步：工作包 3-3（Sonnet 5.5，含阶段 3 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 3-1 · Sonnet 5.5
- 完成：plan 阶段 3 前三项。`server/core/logs.ts`（`LogStore`）：模型输出每次启动一个 `data/logs/models/<模型>/时间.log`（缓冲 200ms 写盘，退出时写一行 `# llama-web: exited …`），事件 / 请求按天 `events|requests/日期.jsonl`；按 `settings.logs` 清理（每模型保留最近 N 个，不删仍打开的；jsonl 保留 keepDays 天），启动、每次新启动、跨天时清理；读取只认固定文件名格式（防路径穿越）。`server/core/request-log.ts` + `proxy.ts`：每个 `/v1` 请求结束时产出一条记录（时间、来源、模型/方案、状态、结果 ok/error/aborted、耗时、token、图片压缩前后、参数摘要）；`GET /v1/models` 和 `/upstream` 不记。`live.ts`：新增 `request` / `log` 消息及 `request-history` / `log-history`，`onActivity` 用于事件落盘。接口 `GET /api/logs`、`GET /api/logs/file`。日志页三个标签、实时 / 历史文件切换、模型筛选、搜索、暂停、自动跟随滚动。
- 验证：`bun test` 320 通过（新增 logs 11、request-log 9、proxy 记录 7、live 5 条，并修了 `readFrames` 测试辅助函数会丢块的问题）；`bun run typecheck` 通过；`bun run build` 通过。构建产物 + 编译成的假 llama-server（临时数据目录、端口 5097，已停已删）实测：非流式 / 流式 / 404 三种请求各一条记录、token 正确；对话内容与 Authorization 全文搜索日志目录为 0 命中；重启后内置浏览器在日志页能看到上次的请求记录和模型输出。**没测**：真实 llama-server / GPU；公网来源（key 名字段已预留，4-1 接入）；局域网来源在真机上的判定（只有单元测试）；事件标签的界面（只看了模型输出和请求两个标签）。
- 剩余：无。
- 决定 / 坑：
  - 请求记录的参数只取白名单标量（采样、max_tokens、reasoning / thinking 开关等）和 messages / tools 的**个数**；`stop`、`user`、`response_format` 等一律不记。
  - 来源：`handleV1(req, { ip, keyName })`。回环地址和本机自己的网卡地址 = 本机，其他 = 局域网，有 `keyName` = 公网。4-1 的公网入口调用时传 `keyName`。
  - 实时输出行经 `/api/stream`（`log` 批量消息）；读者跟不上时丢弃最旧的输出批次（文件里有全量），活动 / 请求事件仍按旧规则（超限断开）。
  - token 数从响应末尾 16KB 里正则取 `prompt_tokens` / `completion_tokens`，不逐块解码，不影响流式转发；超大非流式响应若 usage 不在末尾则记为空。
  - 顺手修了布局：`main` 加 `min-w-0`，宽表格不再撑出整页横向滚动。删除了不再使用的 `PagePlaceholder` 组件。
  - Bash 工具的 heredoc 遇到引号 / 反斜杠组合会整条命令解析失败；改用 Write 工具写文件。
- 下一步：工作包 3-2（Sonnet 5.5）。

---

## 2026-10-01 · 阶段 2 关口 · Opus 5.5
- 完成：在界面里验证了下拉空值修复并给 plan 对应任务打勾。构建产物 + 临时数据目录（端口 5097，已停已删）在内置浏览器实测：设置页 K 缓存类型出现「不传」，选中保存后 `cacheTypeK: null`，刷新仍显示「不传」；模型编辑 mmproj 选文件保存 → 选回「不使用」保存 → `mmproj: null`；聊天模板选 `chat.jinja` 保存 → 选回内置保存 → 字段为空；控制台无错误。
- 阶段 2 状态：plan 阶段 2 任务全部打勾；Codex 审查 5 轮，CR-001～CR-010 已复审关闭，CR-011 已修复未复审。用户确认进入阶段 3，**未亲自试用**。以下验收项至今**没有人实际做过**：酒馆实际连接；往目录放新 gguf → 扫描 → 启用 → 酒馆使用；`名字:RP` 在酒馆里调用；预览命令粘贴到 CMD 手动跑真实 llama-server；长时间深色模式观感。后续出问题时优先怀疑这些。
- 下一步：工作包 3-1（Sonnet 5.5）。

---

## 2026-10-01 · 下拉空值修复 · Sonnet 5.5
- 完成：设置页全局默认参数、模型编辑 mmproj / draft、方案表单聊天模板的「空值」选项恢复显示并能选回。原因：reka-ui 的 `SelectItem` 对 `value === ''` 直接抛错（`SelectItem.js`，`''` 表示清除选择），所以空值选项渲染失败、选了别的就回不去。修法：新增 `app/utils/select-empty.ts`，空值选项用哨兵值 `__none__` 传给下拉，进出时与 `''` 互转；存储格式不变（仍是 `''` / `null`）。
- 验证：`bun test` 288 通过（新增 `tests/app/select-empty.test.ts` 5 条；只回退组件改动时「组件不得再构造 value 为 '' 的下拉项」这条失败）；`bun run typecheck` 通过。**没运行**：浏览器界面（项目没有 DOM 测试库，没新增依赖；也没用真实 data 目录起开发服务器）。
- 剩余：plan 阶段 2「修复下拉空值」**未打勾**——还需在界面里实际点一遍：选别的值再选回「不传 / 无 / 内置模板」，保存后刷新确认。
- 决定 / 坑：测试只能在源码层面锁住「库的规则」和「组件不再写 value: ''」，覆盖不到真实渲染。
- 下一步：用户试用并确认阶段 2 → 3-1。

---

## 2026-10-01 · 阶段 2 第五轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r5.md` 的 CR-011 已修复并标注：`ModelOps.switchTo` 判断「后面还有任务会让目标下线」时检查整个队列（含其他模型），不再只看同一模型的其他方案。CR-009、CR-010 已由复审关闭。
- 验证：`bun test` 283 通过（新增 2 条，只回退产品代码时这 2 条失败）；`bun run typecheck` 通过。本轮没有做真实 HTTP 复现，也没有运行 build（只改了一行判断条件）。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做；阶段 2 的真实界面试用、酒馆连接由用户在关口完成。
- 下一步：修下拉空值问题（Sonnet 5.5）→ 用户试用并确认阶段 2 → 开始 3-1。是否再做第六轮复审由用户决定。

---

## 2026-10-01 · 阶段 2 第四轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r4.md` 的 CR-009、CR-010 已修复并标注。`Scheduler.start(target, { last, reload })`：`last` 在队尾新建任务、不并入更早的同目标任务；`reload` 让在此之前创建的同方案实例（等它的请求结束后）被卸载并重新启动。实例新增 `born` 序号。`ModelOps`：切换方案 / 撤回手动启动后的新目标用 `last`；保存后重启用 `last + reload`；已在目标方案上但有其他方案请求排队时，在队尾补一个回到它的任务。
- 验证：`bun test` 281 通过（model-ops 新增 6 条，修复前其中 3 条失败）；`bun run typecheck`、`bun run build` 通过。构建产物 + 3 秒才就绪且记录启动参数的假 llama-server（临时数据目录、端口 5097，已停已删）真实接口：CR-009 两次启动依次 `ctx=262144`、`ctx=8192`，客户端 200；CR-010 B、C 客户端 200，最终 `B ready`。**没测**：GPU；macOS / Linux；浏览器界面。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做。
- 决定 / 坑：管理操作永远排在已排队的客户端请求之后（FIFO），代价是切换 / 保存后可能先加载一次旧请求要的方案再换回来。被显式停止或更晚的管理操作取代的重启会静默结束（不报错）。
- 下一步：用户决定是否让 Codex 做第五轮复审（`stage-2-codex-r5.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-10-01 · 阶段 2 第三轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r3.md` 的 CR-008 已修复、CR-005 余项已修复（一种组合改为警告），已标注。CR-008：`Scheduler.stop(modelId, { keepRequests: true })` 只撤回手动调用方，保留排队客户端请求及其正在进行的加载；`ModelOps.restart`（切换方案 / 保存后重启）改用它，显式停止不变。CR-005：`quoteCmdProgram` 改为无空白时给 `( ) % ! ^ & | < > ; , =` 加 `^`、有空白时加双引号；「空白 + 成对 %」在预览里给警告 `preview-program-percent`。
- 验证：`bun test` 276 通过（新增 model-ops 3 条、scheduler 1 条、launch 1 条，真实 cmd 程序路径用例 +3）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，已停已删）真实接口复现 CR-008：客户端 `mmm:A` 200，最终 `B ready`。真实 cmd 探测了程序路径 `%` 的三种写法（见审查文件）。**没测**：`cmd /v:on`；交互式 CMD 窗口粘贴；macOS / Linux；GPU。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做。
- 决定 / 坑：「已排队的客户端请求保持请求时的方案」现在在所有切换分支都成立（含同一模型在 drain、待重启）；只有显式停止会拒绝排队请求。新方案排在保留的请求之后（FIFO），所以切换后会先加载一次旧请求要的方案。
- 下一步：用户决定是否让 Codex 做第四轮复审（`stage-2-codex-r4.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-09-30 · 阶段 2 第二轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r2.md` 的 CR-001 / CR-005 余项已修复，CR-007 已核实（Windows 实测不构成错误）并加固，CR-004 的边界说明已认可，各条已标注。CR-001：`Scheduler.cancelManual()` 只撤回手动 start/retry 调用方；`ModelOps.switchTo` 撤回其他方案的排队手动启动并按新方案启动；`snapshot().queue` 不列已取消的任务；后台日志不再把 `stopped` 记成错误。CR-005：新增 `quoteCmdProgram`，程序路径含空白或 `( ) & | < > ^ % ! ; , =` 时用普通双引号。CR-007：参数里的括号也加 `^`。
- 验证：`bun test` 271 通过（新增 model-ops 3 条、scheduler 1 条、真实 cmd.exe 测试 2 条：只含括号的参数 / `; , =`，以及程序路径含空格与元字符）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，已停已删）经真实接口复现审查场景：其他模型 drain 中手动启动 mmm、再切 RP → 队列 `[mmm:RP]`、`inUse` 只有 RP、最终 `mmm:RP ready`，从未启动 `mmm:默认`，日志无错误。**没测**：`cmd /v:on`；交互式 CMD 窗口里手动粘贴；macOS / Linux 上的全量测试；GPU。
- 剩余：plan 阶段 2 的「下拉空值选项不显示」任务仍未做（上一条交接）。
- 决定 / 坑：客户端请求已经排队等方案 A 时切到 B，这个请求仍加载 A（请求时已选定方案），切换只取代管理操作（手动启动 / 重试 / 重启）。以后要改成「切换也取消排队请求」，需要先和用户确认。
- 下一步：用户决定是否再让 Codex 复审（`stage-2-codex-r3.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-09-30 · 阶段 2 审查意见处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex.md` 6 条全部核实成立并修复，每条后已标注「处理」。CR-001/003：新增 `server/core/model-ops.ts`（`ctx.ops`），管理操作按模型递增代数，后发起的操作使等待 drain 的旧重启失效；draining 不再算「已在该方案运行」；改名 / 删除检查实例 + 调度队列 + 待重启目标（`GET /api/models/:id` 新增 `inUse`，抽屉按它禁用按钮）。CR-002：深度输入在 `update:model-value` 转字符串。CR-004：`handleStream` 每连接有界（最新快照合并、activity ≤200 超限断开、背压时跳过心跳、`pull()` 补发）。CR-005：Windows 预览改 `formatCmdCommand`（CMD 转义），界面注明粘贴到 CMD。CR-006：设置测试改用宿主绝对路径，大小写专项仅 Windows。
- 验证：`bun test` 265 通过（新增 model-ops 9 条、live 背压 3 条、args 1 条、`tests/platform/cmd-preview.test.ts` 4 条，后者用真实 cmd.exe 回读参数数组）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，用完已停、已删）经真实接口复现 CR-001（A→B→A drain 中，最终默认 ready、没有启动 RP）和 CR-003（排队中的 RP 删除 409、改名中文提示）；内置浏览器测了设置页深度输入（键入、步进、超限、清空、保存落盘）。**没测**：macOS / Linux 上的全量测试；真实 llama-server / GPU；把预览命令粘贴到真实 llama-server 手动运行；编辑抽屉在排队时按钮禁用的界面效果（只测了接口）。
- 剩余：审查外新发现的问题，已加入 plan 阶段 2 任务（未打勾）：值为 `''` 的下拉选项（设置页全局默认的「不传」、模型编辑的 mmproj/draft「无」、方案表单的「内置模板」）不渲染，控制台报 Reka `SelectItem` 空值错误——用户目前无法在下拉里选回「不传 / 无」。按规则没有顺手修。
- 决定 / 坑：
  - 路由里不要直接调 `scheduler.start/stop/retry`，一律走 `ctx.ops`，否则会绕过代数失效机制。
  - 预览命令目标 shell 定为 CMD：PowerShell 5.1 向原生程序传参不转义内嵌双引号，无法与参数数组一致。非 Windows 仍用 `formatCommand`。
  - Git Bash 里 curl 直接发中文 JSON 会乱码（服务端 404），实测时请求体用 node 写成 UTF-8 文件再 `-d @file`。Bash heredoc 依旧会吃反斜杠，含 `\` 的内容用 Write/Edit。
  - 每连接 2 秒轮询没有移到 hub（`notify()` 已合并去重），审查里这条是可选建议。
- 下一步：用户确认阶段 2（可再请 Codex 复审本次修复）→ 修上面的下拉空值问题（小修，Sonnet 5.5）→ 确认后开始 3-1。

---

## 2026-09-30 · 工作包 2-4 · Sonnet 5.5
- 完成：plan 阶段 2 第 9–11 项。设置页四张卡片（`SettingsDirs` / `SettingsDefaults` / `SettingsImage` / `SettingsServer`，各自保存）；首次启动向导 `/setup`（llama.cpp 状态、添加目录并扫描、旧配置导入，完成或跳过写 `settings.setup.done`）。后端校验在 `server/core/settings-admin.ts`（`applySettingsPatch` 等纯函数），接口 `GET/POST /api/settings`（补丁按段：modelDirs / defaults / image / server / setupDone，整个补丁校验通过才写）。快照新增 `firstRun`，布局在首次快照为 firstRun 时跳一次 `/setup`。
- 验证：`bun test` 247 通过（新增 `tests/core/settings-admin.test.ts`、`live.test.ts` 1 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译的假 llama-server（临时数据目录，已删）在内置浏览器实测：向导重定向、相对路径被拒（中文）、添加目录并扫描、旧配置导入、设置页四段保存（settings.json 与备份落盘）、端口改后的重启提示、删除被引用目录 409、全局默认值进入命令预览、手机宽度 + 深色。**真机**（临时数据目录 + 端口 5094，复用 b11146 的拷贝，`autoUpdate=false`，模型目录只读扫描，测完进程已停、显存回到基线、临时目录已删）：向导添加真实目录扫出 3 个模型；UI 启用 Qwen3.8-27B；mmproj 选择、RP 方案复制、方案切换、全局 ctx 改 32768 用接口完成（对应界面 2-3 已用假进程测过）；`qwen3.8-27b:RP` 经 `/v1/chat/completions` 真实加载并流式 / 非流式回复；切换当前方案触发自动重启（RP → 默认）；**预览命令与 `Get-CimInstance` 读到的真实 llama-server 命令行逐字一致**（端口 7100 也一致）。
- 剩余：无代码剩余。**没测**：酒馆（SillyTavern）实际连接；往目录里新放一个 gguf 再扫描（用了已存在的文件）；把预览命令复制到命令行手动跑一遍（只比对了字符串和真实进程命令行）；长时间看深色界面是否刺眼（需要用户判断）；`nuxt dev` 下的 `/api/settings`；设置页在真实浏览器里的 Tab 键盘操作。
- 决定 / 坑：
  - 新增 `settings.setup.done`（加性字段，`normalizeSettings` 补默认，未写迁移）。向导只在「没目录、没模型、没标记完成」时出现。
  - 监听端口改动只在重启后生效；`ctx.bootPort` 记的是进程启动时读到的 `settings.server.port`，若用 `PORT` / `NITRO_PORT` 环境变量覆盖了端口，提示里的「当前进程使用」会不准。
  - 被已启用模型（file / mmproj / draft）引用的目录不能删，只能停用或改路径；目录 id 保持不变（模型记的是 id）。
  - 调度卡片只开放监听端口、llama-server 端口范围、加载超时、切换等待上限；上限 X 只读显示 1；公网端口 / key / llama.cpp 版本留给阶段 4。
  - Bash 工具的 heredoc 遇到中文 + 引号混合偶尔整条失败，长文件用 Write 工具；Bash 里 `sed` 会吃反斜杠，改含 `\` 的 i18n 用 Edit。
- 下一步：**阶段关口 2**：用户试用界面（重点看好不好用、刺不刺眼）→ Codex 审查（阶段号 2）→ Claude 处理意见 → 确认后开始 3-1。

---

## 2026-09-30 · 工作包 2-3 · Sonnet 5.5
- 完成：plan 阶段 2 第 6–8 项（模型编辑：文件区 + 聊天模板；参数表单 + 命令预览；配置方案增删改）。后端纯函数在 `server/core/models-admin.ts`（`applyFiles` / `saveProfile` / `createProfile` / `renameProfile` / `deleteProfile` / `sanitizeForm` / `listTemplates`），命令预览 `previewLaunch`（`server/core/launch.ts`，和 `planLaunch` 用同一个 `buildLaunchArgs`，缺文件 / 缺 runtime 不抛错而是报 `missing`）。接口：`GET /api/models/:id`（配置 + 全局默认 + 模板列表 + 在跑的方案）、`POST /api/models/:id/{files,preview,profiles}`。前端：`ModelEditor`（抽屉：文件区 + 方案管理）、`ProfileForm`（每个方案一份，常驻挂载，切换方案不丢未保存修改）、`useParamFields`。
- 验证：`bun test` 227 通过（新增 `tests/core/models-edit.test.ts`、`launch.test.ts` 的 previewLaunch 5 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录、端口 5098，用完已停、已删）在内置浏览器实测：选 mmproj 保存（models.json 写入）、新建方案、继承 / 自定义切换后预览实时变化、额外参数重复 / 保留参数警告、保存方案；**真实进程命令行与预览逐字一致**（仅端口由预览示例值 7100 对应实际分配）；运行中保存并重启、改名 / 删除被拒（中文提示）；手机宽度 + 深色。**没测**：真实 llama-server / GPU；`nuxt dev` 下的新接口；草稿模型下拉（只测了 mmproj）；聊天模板在界面上的选择（接口测了，`--chat-template-file` 进了命令）。
- 剩余：无。聊天模板只能从 `data/templates/` 里已有的文件选（导入旧配置会复制进去），界面没有上传 / 新增模板入口（不在任务里）。
- 决定 / 坑：
  - 聊天模板是**方案级**字段（plan 配置结构如此），所以选择控件在方案表单里，不在文件区。
  - 方案接口合成一个 `POST /api/models/:id/profiles`（`op`: create / duplicate / rename / delete / save），名字走 body，不放 URL（中文名 + 解码问题）。方案名不能含 `:`（路由按最后一个冒号拆 `名字:方案`）、≤ 40 字。
  - 有实例在加载 / 运行的方案不能改名 / 删除（实例以方案名为键）；保存文件 / 方案只改配置，运行中的模型要点「保存并重启」才生效。
  - 保存文件时，与当前不同的引用必须是服务端重新扫描出来的对应类型文件；没改的引用不再校验，所以文件丢失的模型仍可编辑。
  - `UInput type="number"` 的 v-model 给的是数字，表单里统一转回字符串，否则 `.trim()` 抛错会让预览静默不刷新（实测踩到）。
  - Bash 工具里带大量引号的 heredoc + `node -e` 容易整条解析失败；长内容用 Write 工具。
- 下一步：工作包 2-4（Sonnet 5.5，设置页 + 首次启动向导 + 阶段 2 试用）。

---

## 2026-09-30 · 工作包 2-2 · Sonnet 5.5
- 完成：plan 阶段 2 第 4–5 项（模型页 已启用 + 扫描发现）。后端：`server/core/models-admin.ts`（`planEnable` / `missingFiles` / `switchProfile`，纯模块）；接口 `POST /api/scan`、`POST /api/models`（启用，服务端重新扫描，不信任前端元数据）、`POST /api/models/:id/{start,stop,retry,profile}`（都立即返回，进度走 `/api/stream`）。快照的 `models[]` 新增 `files`、`missing`（文件丢失）。前端：`ModelCard`（状态、启动 / 停止 / 重试、方案下拉、文件丢失标红且禁用启动、「排队中」）、`DiscoverPanel`（元数据、重新扫描、启用）、`useModelActions`（统一错误 toast）。
- 验证：`bun test` 209 通过（新增 `models-admin.test.ts` 10 条、`live.test.ts` 1 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server + 假 GGUF（临时数据目录、端口 5099，用完已停、已删）在内置浏览器实测：启动 → 运行中；切方案自动重启；文件丢失标红且启动禁用；扫描（分片不完整、损坏文件、mmproj 候选提示）；一键启用；假进程立即退出 → 失败卡片 + 重试；另一模型运行时启动 → 「排队中」；手机宽度 / 深色。**没测**：真实 llama-server / GPU；`nuxt dev` 下的新接口；停止按钮的 `force`（接口支持，界面没放）。
- 剩余：无。编辑入口、mmproj / draft 下拉、聊天模板选择属于 2-3；模型的删除 / 停用没有入口（不在任务里）。
- 决定 / 坑：
  - 修了 2-1 的遗漏：`handleStream` 的 2 秒 `notify()` 轮询没有真正启动（`poll` 变量从未赋值），在途请求数 / 排队 / 文件丢失都不会推送。已补上并加测试。
  - 切换方案：只要有别的方案在加载 / 运行就 stop 再 start（重启）；已经在跑同一方案则只改 `activeProfile`；只有 failed/crashed 标记时清标记，不自动启动。这与阶段 2 验收「切换后模型自动重启」一致，计划未改。
  - 启用：名字取文件名去掉量化后缀（复用 `aliasOf`），名字 / id 冲突自动加 `-2`；默认方案「默认」，不选 mmproj / draft。
  - `server/api/` 下不要放非路由的 `_xxx.ts` 辅助文件（共享代码放 `server/service/models-api.ts`）。
- 下一步：工作包 2-3（Sonnet 5.5，模型编辑：文件区 / 参数表单 / 命令预览 / 配置方案）。

---

## 2026-09-30 · 工作包 2-1 · Sonnet 5.5
- 完成：plan 阶段 2 第 1–3 项（Nuxt UI + 布局 + 深浅色 + i18n；`/api/stream` + `useLive` composable；总览页）。后端 `server/core/live.ts`（`LiveHub`：状态快照、最近 50 条事件、`handleStream` SSE）；context 新增 `live`，scheduler 事件 / llama.cpp 状态 / 配置文件变化都会触发推送；`/api/state` 与流里的 `snapshot` 是同一份文档。前端 `app/`：`layouts/default.vue`（顶栏 + 侧栏）、基础组件 `AppCard` / `PageHeader` / `StateDot` / `StateBadge`、`composables/useLive.ts` / `useFormat.ts`；页面 总览 + 模型 / 日志 / 设置（占位）。旧配置导入表单挪成 `ImportCard`，暂放设置页。
- 验证：`bun test` 198 通过（新增 `tests/core/live.test.ts` 9 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录，端口 5099，用完已停、已删）在内置浏览器实测：加载中（计时 + 进度条 + 排队）→ 失败（红点 + 中文原因 + 事件）、浅 / 深色、手机宽度、杀服务后出现「实时连接已断开」横幅。**没测**：服务重启后浏览器自动重连（EventSource 自带，没单独验证）；没用真实 llama-server / GPU；`nuxt dev` 下的 `/api/stream` 没跑。
- 剩余：总览页的显存条、速度（prompt/生成 t/s）、真实加载百分比属于 3-2，没做；顶栏只显示模型名 + 状态 + llama.cpp 版本（没有速度，没有更新 / 告警提示）。
- 决定 / 坑：
  - `nuxt.config` 设了 `ssr: false`（纯 SPA；本地控制台不需要 SSR，也避免 hydration 问题）。图标用 `@iconify-json/lucide` 本地打包，不走在线 Iconify。
  - `/api/stream` 在自定义入口里原生处理（和 /v1 一样用 `req.signal`），所以不再需要「内部请求 ID」；开发模式走 `server/api/stream.get.ts`。
  - 在途请求数 / 排队的变化没有事件，`handleStream` 每 2 秒 `notify()` 一次，`LiveHub` 只在快照真的变了才推送。
  - 配色：`app/assets/css/main.css` 用 `--ui-*` 变量覆盖 Nuxt UI 的背景 / 文字 / 边框（深色 #1b1d21 灰底），强调色 `blue`；状态色只用在 `StateDot` / `StateBadge` / 错误文字上。后面的页面复用 `AppCard`，不要另写卡片样式。
  - 总览的「启动 / 停止 / 重试」按钮不在 2-1（模型页 2-2 做）；失败卡片的手动重试入口同理（CR-003 余项）。
- 下一步：工作包 2-2（Sonnet 5.5，模型页：已启用列表 + 扫描发现）。

---

## 2026-09-30 · 阶段 1 第三轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-1-codex-r3.md` 的 CR-001 剩余、CR-013 已修复，各条后写了「处理」。proxy 冷加载流所有结束路径改用有界的 `sendFinal()`（删 `sendError`）；`bounded()` 增加 `activeBoundedWaits()` 计数。store 的 `refresh()` 读到新内容时立即调用 watch 回调；context 的 `openStore` 导出供测试。
- 验证：`bun test` 189 通过（全量 2 次）；`bun run typecheck` 通过；三条新测试在上一版代码上确认失败。Codex 首跑时 scheduler「crash -> crashed」的一次失败在 Windows 上连跑 30 次未复现；已去掉会替换全局 `AbortSignal.prototype` 的测试写法，原因仍未确认。没有 build（用户 start.bat 在运行）。
- 剩余：无（CR-003 余项按用户决定在阶段 2）。
- 决定 / 坑：测试里不要替换全局原型（AbortSignal 等），bun test 同一进程跑所有文件。
- 下一步：Codex 第四轮复审；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 第二轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-1-codex-r2.md` 的 CR-001 剩余、CR-004 剩余、CR-012 全部修复，各条后写了「处理」。
  - proxy：新增导出 `bounded(p, signal, ms?)`（每次等待一个 abort 监听，结束即移除）；冷加载转发循环所有等待以 `ac.signal` 为界（客户端断开 + 租约 abort）；模型中止后的最后错误事件最多等 `finalEventTimeoutMs`（默认 5 秒）。
  - store：新增 `refresh()`，`update()` 从磁盘最新内容开始；磁盘文件损坏时抛 StoreError，不覆盖。context 新增 `refresh()`；`commitImport` 先 refresh，失败为 `ImportError('config-invalid')`。
- 验证：`bun test` 186 通过；`bun run typecheck` 通过；proxy 测试连跑 3 次。新的强卸载 / 崩溃任务退出测试、store 手改测试在旧代码上确认失败。没有 build（用户 start.bat 在运行）。
- 剩余：无（CR-003 余项按用户决定在阶段 2）。
- 决定 / 坑：`JsonStore.update()` 现在会先读磁盘；手改文件写坏时，所有写入（包括下载完成写 `llamacpp.current`）都会失败并报错，而不是覆盖掉手改。Windows 上 setTimeout 精度约 15 ms，涉及大量小间隔分块的测试要留足超时。
- 下一步：Codex 第三轮复审；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 审查意见 · 用户决定落地 · Opus 5.5
- 完成：用户决定 CR-010 选 A、CR-011 选 B、CR-003 余项留到阶段 2。CR-010：计划关键决定 5 加导入例外；导入结果 `mmproj` 改为所选文件相对路径，状态页导入结果显示文件名并提示如何更换。CR-011：scheduler 去掉 `servedOk`，自动重载出来的进程再崩溃即 failed，手动 start/retry 后重新计；计划关键决定 22、状态机图、变更记录已同步。审查文件对应条目已更新。
- 验证：`bun test` 178 通过；`bun run typecheck` 通过。没有 build（用户的 start.bat 仍在运行，见下一条）。
- 剩余：CR-003 余项（配置错误的手动恢复入口）→ 阶段 2 模型页 / 失败卡片。等 Codex 复审结论。
- 决定 / 坑：`Lease.release('ok')` 现在只作记录，不影响重载额度。
- 下一步：Codex 复审阶段 1 修复；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 审查意见处理 · Opus 5.5
- 完成：逐条核实 `docs/reviews/stage-1-codex.md`，每条后面写了「处理」。已修复 CR-001/002/004/005/006/007/008/009；CR-003 部分修复；CR-010、CR-011 需要用户决定。没有打勾（按指南）。
  - 001 冷加载流：租约随 abort 立即释放，循环的每次写入都和断连竞争。002 runner：先装 exit 处理器再写 pids.json，写失败 → `register-failed` 并杀进程。003 scheduler 新增 `isPrecondition`，`no-runtime` 不再锁 failed。004/005 导入拆成 `readImportSource` + 同步的 `commitImport`（按最新文档规划、失败回滚 settings 和新建模板）。006 备份按（时间戳, 数值序号）排序、命名取最大序号 +1。007 新增 `server/core/origin.ts` + `server/middleware/admin-origin.ts`（/api 写请求：跨来源 403、非 JSON 415）。008 `maxLoaded` 归一化为 1。009 测试注入 platform / 用宿主绝对路径。
- 验证：`bun test` 177 通过；`bun run typecheck` 通过。proxy 测试连跑 3 次通过；新的背压测试在旧代码上失败、新代码通过。`nuxt dev`（临时数据目录、端口 5099，用完已停、已删）实测 origin 中间件：跨来源表单/JSON 403，无来源表单 415，同源 JSON 预览 200。
  - **`bun run build` 失败**：用户的 start.bat 正在运行，`.output` 里 sharp 的 dll 被占用；构建在失败前已经删掉了 `.output` 里其他文件。运行中的实例 /v1、/api 仍可用，状态页静态资源 500。用户关掉 start.bat 重开会自动重新构建。本次 build 没有验证。
  - 没在 macOS/Linux 跑测试（CR-009 只在 Windows 验证）；没做 GPU 真机测试。
- 剩余：CR-003 的其余配置错误（file-missing 等）改配置后仍要重启才能恢复，手动重试入口在阶段 2（模型页、失败卡片）。CR-010（导入自动配 mmproj）、CR-011（崩溃重载额度的重置条件）等用户决定。
- 决定 / 坑：
  - Bun：在 `req.signal` 的 abort 回调里同步 `writer.abort()` SSE 的 TransformStream，Bun 服务器读响应体时会报未处理的拒绝；改为让等待和断连 Promise 竞争。
  - 手改文件后 100 ms 防抖内的任何保存会覆盖手改（store 通用限制）；origin 检查不防 DNS 重绑定。
  - 用户的 start.bat 在跑时别 `bun run build`，会删掉 `.output`。
- 下一步：用户决定 CR-010 / CR-011（及 CR-003 余项），重启 start.bat 试用，确认后开始 2-1。

## 2026-09-30 · 工作包 1-6 · Opus 5.5
- 完成：plan 阶段 1 剩余三项（llama.cpp 初始获取、start.bat、真机冒烟）打勾，阶段 1 全部完成。修复：`llamacpp.ts` 新增 `pickCudaVersion`（官方已从 CUDA 13.3 换成 13.4，原来写死精确版本导致 `asset-missing`）；`start.bat` 的 `>/dev/null` 改 `>nul`、运行行加 `call`（bun 是 bun.cmd）、工作区改回 CRLF。新增测试 `tests/platform/start-bat.test.ts`、llamacpp 两条。
- 验证：`bun test` 159 通过；`typecheck`、`build` 通过。真机（仓库 `data/`，RTX 5090，b11146）逐条验收，全部通过：
  - 真实下载 bin 150 MB + cudart 423 MB，SHA-256 校验、解压、自动设为 current。网速约 300 KB/s，共约 25 分钟。
  - 导入旧 swap-config：3 个模型，名字与旧别名一致。
  - 冷加载流式：约 46–49 秒，每 15 秒一次 `: loading` 心跳，然后逐块输出。
  - 切换：draining → unloading → stopped → loading → ready，只剩一个 llama-server。
  - 排队：长回复在途时另一客户端要别的模型，旧模型 draining（inflight 1），长回复结束后 0.2 秒才开始卸载；非流式请求等了 130 秒没断。
  - 图片：日志 `2000x1000 png 59KB -> 896x448 jpeg 11KB`，回答正确；没有 mmproj 的临时模型收到中文 400，且不触发加载（临时条目已删）。
  - 关 start.bat 窗口 3.8 秒内全部退出、pids.json 清空。强杀 bun 时 llama-server 随之退出；手造真实残留后启动 → `killed 1`。
  - **没测**：酒馆本身（用脚本模拟 OpenAI 流式请求，酒馆留给用户在关口试用）。
- 剩余：无。
- 决定 / 坑：
  - `cudaRuntime` 语义改为「首选版本」：精确版本没有时，选同一主版本里最新的次版本（必须同时有 cudart），不会跨主版本。settings 里的值不会被改写。**需要用户知悉**（已写进变更记录）。
  - Windows 下文件还开着时，目录列表显示的大小会一直是 0，不代表下载卡住。
  - 这台机器 PowerShell 的 `bun` 是 `bun.ps1/bun.cmd`，`Start-Process` 要用真实的 bun.exe 路径。控制台窗口句柄要按标题 `llama-web` 找（conhost 的 MainWindowHandle 为 0）。
  - 1-5 留下的两个待确认点（导入时 mmproj 自动配对、`--jinja` 不触发重复警告）仍待用户确认。
- 下一步：阶段关口 1（用户试用 + Codex 审查），确认后才开始 2-1。

## 2026-09-30 · 工作包 1-5 · Sonnet 5.5
- 完成：plan 阶段 1 第 13 项（旧配置导入）、第 15 项（最简状态页）。`server/core/importer.ts`（+ `POST /api/import`，`{ path, dryRun? }`）、`server/core/llamacpp.ts`（版本目录扫描 + 初始下载）、`GET /api/state`、`app/pages/index.vue`（状态 + 导入表单）、`start.bat`、`.gitattributes`（bat 强制 CRLF）。context 新增 `updateSettings / updateModels / getRuntimeStatus`（自己写盘不会触发文件监听，必须走这两个）。
- 验证：`bun test` 155 通过；`bun run typecheck`、`bun run build` 通过。构建产物经 `start.bat` 启动（临时数据目录，端口 5099，用完已删）：`/api/state`、页面 200；对旧 swap-config.json 做预览和真实导入（写入临时目录）：3 个模型、mmproj 和 `-md` 草稿模型配对正确、聊天模板复制成功、key/域名未导入；错误路径返回中文 400。**没有**实际下载 llama.cpp（未经用户同意不下几百 MB），**没有**测关闭 start.bat 窗口，没用 GPU。
- 剩余（所以这两项没打勾）：
  - 「llama.cpp 初始获取」：下载 / 校验 / 解压逻辑只用假网络和假解压测过，真实的 GitHub 资产格式只核对了 API 返回（`nightly-tag.txt`、`digest` 字段存在）。1-6 真机时请用户同意后跑一次真实下载。
  - 「start.bat」：能构建并启动；「关窗口即停止」留给 1-6 实测。
- 决定 / 坑：
  - **需要用户确认**：导入时 mmproj 按目录自动配对（沿用旧生成器：优先 BF16/F16/F32），与关键决定 5「mmproj 默认不选」不同。理由：否则旧配置导入后图片功能全部失效。手动启用模型仍按决定 5。
  - 旧配置里全局没写的参数视为「不传」（旧生成器就是这样），所以导入后 `defaults.batchSize` 等可能为 null。全局默认只在**首次导入**（models.json 为空）时覆盖；再次导入保留现有默认值，各模型的覆盖项按当时生效的默认值重新计算。已存在的同名模型跳过。
  - 旧 `-md "<路径>"` 在模型目录内且扫描到时转成 `draft` 字段并从额外参数移除；否则留在额外参数并警告。旧的 `chat_template`（名字）追加为 `--chat-template <名>`；`chat_template_file` 复制到 `data/templates/`，同名不同内容时改名 `<名>-imported`。`public` 段（域名、隧道、key）整体不导入。
  - 初始下载只在 `data/runtime` 里没有任何可用版本、且 `llamacpp.autoUpdate` 为 true 时发生；有版本但 `llamacpp.current` 为空或失效时自动采用最新已装版本。后台执行，不阻塞启动；下载前请求会得到 `no-runtime`。状态见 `/api/state` 的 `llamacpp.runtime`。解压用系统 `tar.exe`（Windows 自带 bsdtar），没加依赖。下载先到 `.tmp-*` 目录，完整后整体改名，失败不留半个版本。摘要缺失一律拒绝安装。
  - 这台机器上启动子进程很慢（约 2.5 秒），涉及 spawn 的测试要给足超时。`cmd /c start.bat` 要写成 `.\start.bat`。
  - 状态页只轮询 `/api/state`（每 2 秒），SSE 在 2-1。
- 下一步：工作包 1-6（Opus 5.5，阶段 1 验收）。真机测试前先告诉用户（占用 GPU、需先关旧 llama-swap、需同意下载 llama.cpp）。

## 2026-09-30 · 工作包 1-4 · Opus 5.5
- 完成：plan 阶段 1 第 10–12 项 +「单元测试」项。`server/core/` 新增 config.ts（settings / models 结构、默认值、补全）、routing.ts、launch.ts、proxy.ts、i18n.ts、preprocess/（index + image）；`server/service/context.ts` 单例接线；自定义 Bun 入口 `server/entry.ts`；开发模式路由 `server/routes/{v1,upstream}/[...path].ts`；插件 `plugins/residue.ts` 换成 `plugins/app.ts`。错误文案在 i18n `api` / `loadError`。
- 验证：`bun test` 133 通过（全量 2 次，proxy 3 次）；`typecheck`、`build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录，用完已删）：/v1/models、加载中心跳后逐 chunk 输出、长流式结束后才切换、非流式静默等 15 秒不断开、断开后切换、图片 2000x1000 png → 896x448 jpeg、无 mmproj 中文 400、/upstream、手改 settings.json 热重载。`nuxt dev` 下同样测了流式 / 断开 / 切换 / upstream。**没用真实 llama-server 和 GPU**，留给 1-6。
- 剩余：无。未做：给 Nitro 处理函数传 signal / IP 的内部请求 ID（2-1 的 /api/stream 需要时再做）；入口里 SIGINT / SIGHUP 优雅退出的代码没测过（1-6 测 start.bat）。
- 决定 / 坑：
  - **Bun 1.3.14 会崩**：在响应流 `cancel` 里对上游 fetch body 调 `reader.cancel()` 会段错误。只用 fetch 的 AbortSignal 取消上游。以后写流式代码别用它。
  - `nitro.entry` 放在 `$production` 下：开发模式下它也会替换 dev worker 入口（Node 里 `Bun is not defined`）。
  - 流式请求、目标没 ready：立刻回 200 SSE，先发 `: loading`，之后每 heartbeatSec 一次；加载失败发 `data: {"error":…}` 再关流。目标已 ready：透传上游状态码和头。心跳百分比预留了 `progressOf`（3-2 接）。
  - 租约释放：上游结束 / 出错 / 客户端断开（req.signal 或响应流 cancel）都会 release；中止上游就立刻释放，不等下一次 pull（dev 模式下没人 pull）。
  - model 解析：整串能匹配就用整串（名字里可以有 `:`），否则按最后一个 `:` 拆；依次按 name、id、忽略大小写的 name 找。没有 model 字段：ready 的模型，其次 loading 的，否则 400。
  - 转发时去掉 authorization、accept-encoding 和逐跳头。/upstream 不会触发加载，只转发 ready 的模型；`/upstream/x` 308 到 `/upstream/x/`。llama-server 自带网页用绝对路径的资源在前缀下能不能用还没验证。
  - 请求体上限 100 MB（代码常量 `MAX_BODY_BYTES`，没加设置项）。图片只处理 base64 data URI，远程 URL 不动；小于 maxEdge 且格式相同的原样转发。按方案覆盖用 `profile.preprocess.image`（计划结构里只有方案级）。压缩前后尺寸目前只打到控制台。
  - 手改设置：portRange / drainTimeoutSec / heartbeatSec / 启动参数下次使用时生效；maxLoaded、server.host/port 要重启。设置文件损坏时用默认值并打错误日志，不覆盖文件。
  - `profile.chatTemplate` = `data/templates/` 下的文件名。`llamacpp.current` 为空 → 加载失败 `no-runtime`，1-5 初始获取后要写入它。
- 下一步：工作包 1-5（Sonnet 5.5）。

## 2026-09-30 · 工作包 1-3 · Opus 5.5
- 完成：plan 阶段 1 第 7–9 项。`server/core/runner.ts`（Runner / RunningProcess / PidRegistry / LoadError）、`residue.ts`（cleanupResidue、runStartupCleanup）、`scheduler.ts`；`server/plugins/residue.ts` 启动时跑清理。测试 `tests/core/{scheduler,runner,residue}.test.ts`，假 llama-server `tests/fixtures/fake-llama-server.ts`。
- 验证：`bun test` 89 通过（连跑 3 次）；`bun run typecheck` 通过；`bun run build` 通过。真机：真实 llama-server b10809 + 27B Q4（`-c 4096`），scheduler → runner 加载 37 秒、/health 200、对话 200；停止 3.6 秒，进程树（含其子进程）全灭、端口释放、pids.json 清空；残留清理杀掉运行目录下的真实进程、放过目录外的。临时脚本在仓库外，已删除。
- 剩余：无。「单元测试」项仍未打勾（路由解析在 1-4）。强杀 llama-web 后的残留场景留到 1-6。
- 决定 / 坑：
  - runner 用 `node:child_process`（不用 Bun.spawn），这样 `nuxt dev` 的 Node 服务器下也能用。停止 = `taskkill /T /F`，没有温和退出。`'exit'` 后等 `'close'`（最多 1 秒）再结算，保证失败时的最后几行日志完整。
  - runner 本身不懂 settings：`start({ exe, args: port => [...], tag, loadTimeoutMs, onLine })`，args 由调用方用 args.ts 按端口生成。端口按范围从小到大找第一个能 listen 的，同进程内已分配的端口跳过。
  - scheduler 通过注入的 `launch(target) => ModelProcess` 工作（RunningProcess 结构上符合）。目标 = 模型 + 方案；换方案 = 另一个目标 = 重启。所有加载经一个 FIFO 队列串行执行；ready 的目标直接给 lease。
  - 请求必须 `lease.release()`；转发正常结束时传 `'ok'`。lease.signal 在强制卸载 / 崩溃时 abort，1-4 的转发要监听它取消上游。
  - **需要用户确认的细节**：「崩溃后最多自动重载一次」实现为：崩溃 → crashed，下一个请求自动重载；重载失败或重载后还没有任何请求 `release('ok')` 就再次崩溃 → failed；重载后成功服务过请求，之后再崩溃仍可再自动重载一次。手动启动不算自动重载。
  - 手动 `stop(modelId)`：拒绝排队请求（code `stopped`）、中止加载中的进程、ready 的先 drain（`force` 直接杀）、清掉 failed。draining 中的模型不接新请求，新请求排到队尾。
  - 等待中的请求 abort 后移除；未开始的切换没人等就丢弃；已开始的切换会做完。
  - 1-4 接线：先 `await runStartupCleanup(dataDir)` 再建 scheduler；退出时 `scheduler.shutdown()`。错误都是 code（SchedulerError / LoadError），中文文案还没加进 i18n。
- 下一步：工作包 1-4（Opus 5.5）。

## 2026-09-30 · 工作包 1-2 · Sonnet 5.5
- 完成：plan 阶段 1 第 3–6 项。`server/core/` 下 store.ts、gguf.ts、scanner.ts、args.ts、types.ts（FileRef / ModelDir）；测试在 `tests/core/`，假 GGUF 构造器 `tests/fixtures/gguf-builder.ts`。
- 验证：`bun test` 52 通过（连跑 3 次）；`bun run typecheck` 通过（只覆盖 `server/` 和 `app/`，不含 `tests/`）。全部用自造的假文件和临时目录，没碰真实模型或配置。
- 剩余：无。「单元测试」那一项没打勾：scheduler 和路由解析还没写。
- 决定 / 坑：
  - store：`JsonStore<T>`（load / get / save / update / watch / close）。缺文件写默认值；JSON 损坏、无 version、版本更新时抛 `StoreError`，不覆盖原文件；`watch` 遇到坏文件保留旧值并回调 onError，自己写的不触发回调。每次覆盖前备份到 `backups/`（默认留 20 个）。迁移函数 `migrations[n]` 是 n→n+1。
  - gguf：`readGgufMeta(path)` 只读头部和 tensor 信息，大数组直接跳过。参数量优先 `general.parameter_count`，没有就累加 tensor（分片时只是本片的）。
  - scanner：`scanModelDirs(dirs)` 返回 `entries`（kind = model/mmproj/draft/invalid，分片合并，`candidates` 只列同目录文件）和 `warnings`。mmproj 看架构 `clip` / `general.type` / 文件名；draft 看文件名或架构含 mtp / draft。`resolveFileRef` 拒绝 `..` 越界。`maxDepth` 0 = 只扫根目录。跳过 `.` 和 `$` 开头的目录。
  - args：`buildLaunchArgs` 返回参数数组（不含 exe）、warnings（只有 code / flag / layer，中文文案放 i18n）、ok。表单项用长参数名；`undefined` = 继承，`null` 或 `''` = 自定义为不传。额外参数三层（全局 → 模型 → 方案）依次拼接，后出现的同名参数替换前面的（不警告），同一段里重复才警告；`--host` / `--port` 会被剔除。额外参数在表单参数之后，host / port 永远在最后。
  - **和计划文档有出入，待用户确认**：计划里 `--jinja` 被当作「表单已管理」的例子，但设置结构里没有对应字段，所以 `--jinja` 目前不会触发重复警告。
  - 给 `tests/platform/process-tree.test.ts` 的两个用例加了 30 秒超时：这台机器上启动 bun 子进程要 2.5–5 秒，全量跑时会超过默认 5 秒。逻辑没改。
  - 没新增依赖，参数拆分是自己写的（string-argv 不需要了）。
- 下一步：工作包 1-3（Opus 5.5）。

## 2026-09-30 · 工作包 1-1 · Opus 5.5
- 完成：plan 阶段 1 第 1–2 项。Nuxt 4.5 + Bun 1.3 + TS 脚手架（nitro preset bun、strict、i18n/zh-CN.ts、最小首页）；技术验证三项；AGENTS.md 常用命令。
- 验证：`bun test` 6 通过（tests/platform/sharp、process-tree）；`bun run typecheck` 通过；`bun run build` 通过；`bun run dev` 首页 200。SSE/入口用临时路由 + 构建产物实测，临时文件已删除。
- 剩余：无。真实 llama-server 的启动 / 杀树没测（还没有二进制），按指南在 1-3 测；关 start.bat 窗口的场景在 1-6 测。
- 决定 / 坑：
  - 新增关键决定 25：Nitro 自带 bun 入口拿不到 req.signal 和客户端 IP、Bun.serve 默认空闲超时 10 秒会断开静默请求。改用自定义 Bun 入口（`nitro.entry`，必须绝对路径，`~~` 别名不解析）：`server.timeout(req, 0)`；/v1、/upstream 走 Bun 原生；其余走 `nitroApp.localFetch`，入口覆盖写入内部请求 ID 头，处理函数据此从共享 Map 取 signal / IP。以上都已实测可行，细节见 plan「风险与待验证」。
  - `nuxt dev` 不走自定义入口，1-4 要考虑开发模式下 /v1 怎么跑（或约定只用构建产物测转发）。
  - 自带入口会先把整个请求体读进内存；请求体上限要在自定义入口里做。
  - Bun 子进程会随 Bun 父进程一起退出（即使 taskkill /F 父进程），残留风险比预期小，但 pids.json 清理仍要做。主动停止用 `taskkill /PID <pid> /T /F`。
  - 读进程 exe 路径：PowerShell `Get-CimInstance Win32_Process`，耗时数秒，只在启动清理时用。
  - typescript 固定 5.x（vue-tsc 不支持 TS 7）。
- 下一步：工作包 1-2（Sonnet 5.5）。

## 2026-09-30 · 规划 · Opus 5.5
- 完成：需求问答（24 轮），写出 docs/plan.html、docs/claude-guide.html、AGENTS.md；建立公开仓库。
- 验证：无代码。
- 剩余：无。
- 决定 / 坑：所有决定见 plan.html「关键决定」。开发按工作包进行，一个工作包一个会话。
- 下一步：工作包 1-1（Opus 5.5）。
