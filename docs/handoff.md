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
