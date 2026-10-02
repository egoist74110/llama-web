# 交接记录

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
- 决定 / 坑：用户公司网络打不开第一个域名（不是程序问题；DSH 在别的机器上，本机测不到）。用户第二次建隧道时新建了隧道 llama-web 并替换了托管 token（多半是在修复生效前跑的），所以**第一个域名现在 530**（CNAME 仍指向无连接的旧隧道 llm）；用新界面对该域名再跑一次即可改指（会改 DNS，先问用户），或在后台删掉旧隧道 / 记录。Cloudflare 不提供免费域名、API 不能代注册。测试用 `LLAMA_WEB_CLOUDFLARE_API` 指向假 Cloudflare。界面目前四张公网卡片并列，用户认为太复杂 → 4-6。
- 下一步：工作包 4-6「公网模块合并 + 引导 + 阶段 4 验收」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。

---

## 2026-10-01 · 工作包 4-4（含阶段 4 验收） · Opus 5.5
- 完成：plan 阶段 4「隧道托管」。`server/core/tunnel.ts`：`extractToken`（裸 token 或整条命令）、打码 / `redact`；查找 cloudflared（PATH + 常见安装位置）→ 复制到 `data/runtime/cloudflared/`，没有就从官方 Release 下载并校验 SHA-256；`TunnelManager`（token 走环境变量 `TUNNEL_TOKEN`，输出逐行脱敏，识别 Registered / Unregistered tunnel connection → 已连通；意外退出退避重试，token 无效不重试；pid 记入 pids.json，停止杀进程树）。仅在「公网入口监听中 + 已存 token + 托管开关开」时运行。settings.json → v2（删 `tunnelName`，加 `public.tunnelEnabled`，迁移函数）；secrets.json → v2（加 `tunnelToken`）。接口 `/api/tunnel/token`、`/api/tunnel/retry`；快照 `tunnel`、事件 `kind:'tunnel'`。界面：设置页「Cloudflare 隧道」卡片 + 带 SVG 示意图的分步指引；公网入口卡片去掉隧道名 / DNS 命令。README 隧道一节改写（并更正 secrets.json 是明文而非哈希）。
- 验证：`bun test` 全部通过（新增 tunnel 21 条含真实子进程、keys / settings / residue 若干）；`bun run typecheck`、`bun run build` 通过。真机（临时数据目录，端口 5097 / 18090，已停已删，GPU 回到基线）：已装 cloudflared 2026.5.0 被复制并运行；伪造 token 连不上时显示「正在连接」+ 最近报错；用户自己的 token：状态已连通（4 条连接）；经隧道无 key / 错 key / 吊销后的 key → 401，带 key 的 /v1/models 200，/api/state、/api/keys、/settings、/upstream、/ → 404；带 key 流式对话触发 Qwen3.8-27B 加载（41 秒）并出流；请求记录 source=public + key 名；token / key 未出现在日志、事件、server 输出；真实 settings.json 副本迁移到 v2 且生成备份；`git add -f data/x` 被 pre-commit 拒绝。
- 剩余：阶段 4 验收里**未验证**两项：官方出新版时的自动下载安装（当前官方最新仍是 b11146，没有可下载的）、真实模型下的版本回退（只有一个版本；回退逻辑在 4-2 用假目录验证过）。**没测**：cloudflared 下载路径的真实网络（只有假 fetch 的单测；本机已装）；Windows 服务形式的 cloudflared 与本隧道并存；深色模式 / 手机宽度下的新卡片；`nuxt dev` 下（只会显示「开发模式没有公网入口」）。
- 决定 / 坑：与 4-3 记录的差异——用 `TUNNEL_TOKEN` 环境变量代替 `--token`（不进进程列表）；已装的 cloudflared 复制到 `data/runtime/cloudflared/` 再运行，这样残留清理只杀 runtime 下进程的规则同样覆盖隧道。真实 cloudflared 遇到不存在的隧道 token 不会退出而是一直内部重试，所以界面显示「正在连接」+ 最近报错，而不是错误卡片。`dnsCommand` / `routeDnsCommand` / `bad-tunnel` 已删。Windows 上硬杀 llama-web 时 cloudflared 随管道关闭自己退出（观察到，不依赖它）。
- 下一步：新增工作包 4-5「一键建隧道」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。真机试用发现：用户真实 data 里存的是 japan-home 隧道的 token（已清空并关闭托管开关），llm 隧道（域名 CNAME 指向它）当前无连接且入口规则仍指向测试端口 18090，4-5 里一并处理。

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
