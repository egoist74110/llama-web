# 阶段 1 Codex 复审（第三轮）

日期：2026-09-30。总体结论：**需要返工（rework required）**。

本轮三项中，**CR-004、CR-012 已关闭，CR-001 部分关闭**；另确认一个修复引入的中等严重程度问题 **CR-013**。没有修改代码，仅新增本报告。

## 范围与依据

- 已读 `AGENTS.md`、最新交接、上一轮报告及 CR-001/004/012 的“处理”；同时核对计划的配置自动重载、排队中断、流式转发规则及阶段 1 验收要求。
- `git log --oneline de61e94..6445c20` 确认范围只有 `6445c20` 一个修复提交；检查完整 diff，共 10 个文件变化。
- 本地开始时工作区干净，获取远端后 fast-forward 到 `6445c20`。下述代码行号对应这个版本。
- CR-002、003、005～011 不重新做完整审查；只检查本次修改直接影响的保存失败、备份、配置错误和 runtime 接线。CR-003 的配置错误恢复入口仍按用户决定留到阶段 2。

## 逐条关闭核对

| 编号 | 结论 | 核对结果 |
| --- | --- | --- |
| CR-001 剩余部分 | **部分关闭** | `proxy.ts:332`、`:333`、`:337` 用 ac.signal 中断下游等待；`:343` 的模型中止错误事件有有限等待。新增强卸载/崩溃测试通过，独立重复上一轮“只读一个心跳后停止读取”的真实 HTTP 上游探查也通过：未取消客户端，强卸载使用默认 5 秒期限后约 5047 ms 移除原 req.signal 监听；崩溃使用 60 ms 注入期限后约 61 ms 清理，租约均释放。但响应头返回前崩溃走另一条未限定等待的错误发送路径，任务仍挂起，详见剩余问题。 |
| CR-004 剩余部分 | **已关闭** | `commitImport` 规划前调用 context.refresh；store.refresh 读取磁盘有效内容，update 也从磁盘开始。新增 store/importer 测试通过。独立使用真实 getContext、JsonStore 和 watcher，在扫描后手改 settings 的 sampleSec=7，并添加 Manual 模型，立即导入、不等待防抖；220 ms 后磁盘和 context 的 sampleSec 都为 7，模型为 Manual、A。分别损坏 settings/models 后导入均报 config-invalid，坏文件及另一文件保持不变。 |
| CR-012 | **已关闭** | 移除常驻 goneP 的循环 race；bounded 每次等待结束移除自己的 onAbort。新增单测通过。按上一轮真实 Proxy/Scheduler、进程内替身 fetch 的方式正常读取 10,000 块：取消等待者峰值 **1**，结束后 **0**，添加/移除均 **20,002** 次；原 req.signal 监听移除一次，inflight=0。另验证提前 abort、已 abort、超时之后底层 Promise 再拒绝，没有观测到未处理拒绝。 |

CR-012 的长流仓库测试 `tests/core/proxy.test.ts:415` 名称虽然写“全部移除”，实际只断言峰值，没有断言最终 active=0；本轮独立探查补上了结束后的断言证据，因此不因这个测试表达缺口重开已验证关闭的问题。后续可将该断言固化，并仅统计 bounded 所拥有的监听，避免把 once 自动移除与重复 remove 混入计数。

## 剩余问题（沿用原编号）

### CR-001 · 部分关闭 · 剩余严重程度：中

- **文件与行号**：`server/core/proxy.ts:301`～`:305`；关联 `server/core/proxy.ts:267`～`:271`、`:343`～`:347`。
- **问题描述**：有限的最后错误事件发送只覆盖拿到上游 Response 后的转发 catch。callUpstream 在响应头返回前失败时，先移除 req.signal 监听、释放租约，然后直接 `await sendError(...)`。sendError 的 write/close 没有取消或超时边界，且这里不使用 finalEventTimeoutMs。客户端仍连接却不读取时，转发任务和 SSE 响应不能自行结束。租约和监听已清理并不等于整个任务已清理。
- **触发场景**：冷加载请求读取一次 loading 心跳后停止 pull；模型已 ready，但上游尚未返回响应头，此时进程崩溃或模型被强卸载，fetch 拒绝。代码进入早期 catch，最后的 model_interrupted 错误事件无限等待下游。普通的响应头前连接失败也走这个发送分支。
- **复现证据**：真实 Proxy/Scheduler + 临时 Bun HTTP 上游，上游收到请求后暂不返回响应头。终止上游并结算进程 exited，注入 finalEventTimeoutMs=50。250 ms 后模型为 crashed、inflight=0、req.signal 监听已移除一次，但 writer 仍有一个未完成 write；客户端没有 abort。显式 cancel 客户端后，该 write 才结束。第一笔 loading write 已完成，悬挂的是错误事件；由于 sendError 正在 await 它，早期 catch 尚未返回。复现后已取消流、释放上游等待并关闭服务。
- **建议修改**：把各条终止路径的最后错误事件发送统一为有界操作，包括响应头前 fetch 失败和 acquire 失败分支；超时或客户端断开时结束 writer，处理全部拒绝。不要在移除唯一的客户端通知后留下无限等待。保留正常加载期间的心跳及 Bun fetch reader.cancel 兼容限制。
- **缺失测试**：新增 `tests/core/proxy.test.ts:393`、`:405` 覆盖已有响应头后的背压，未覆盖响应头前崩溃。增加该场景，客户端不读取、不取消，确认错误发送及完整任务在期限内结束；仅计 req.signal 监听的移除次数会漏掉本路径。

这是上一轮“模型中止后的最后错误事件不能无限等待”要求尚未覆盖的分支，沿用 CR-001；不是本轮新引入的分支。
- **处理（2026-09-30，第四轮修复）：已修复。** 核实成立：拿到响应头之前失败的分支（以及 acquire 失败分支）仍直接 `await sendError()`，且先移除了 req.signal 监听。改为统一的 `sendFinal()`：写最后一条错误事件并关闭，整个过程以客户端断开（`gone.signal`）和 `finalEventTimeoutMs` 为界，没送达就 `writer.abort()` 结束响应；三条结束路径（acquire 失败、响应头前失败、转发中模型中止）都用它，`sendError` 已删除；req.signal 监听改为在最后事件处理完之后才移除，发送期间仍能收到断开通知。新增测试：上游收下请求但不回响应头，客户端读一次心跳后不读不取消，进程崩溃 → 租约释放、任务在期限内结束、响应被中止（之后 read 失败而不是拿到排队的数据）；该测试在上一版代码上失败。

## 新问题

### CR-013 · 中 · 保存失败后，refresh 消耗了手改通知，但 context 缓存未更新

- **文件与行号**：`server/core/store.ts:137`～`:139`、`:152`～`:154`、`:170`；`server/service/context.ts:58`～`:60`。
- **问题描述**：store.update 先 refresh，把磁盘手改放进 store.current 并将原文本记为 lastWritten；只有 update 全部成功，openStore 才将返回值赋给独立的 value。如果随后备份/原子保存失败，context 的 value 仍是旧值。watcher 再读同一有效手改时看到 text===lastWritten，直接返回，永久遗漏该手改的 onChange。故障既有正常的保存失败提示，又额外破坏了计划要求的“手改自动重载”。
- **触发场景**：下载完成写入 current 时，用户有效的手改刚落盘；refresh 成功后，备份目录异常或其他保存 I/O 故障使写入抛错。磁盘手改没有丢失，但运行中的 getSettings 继续使用旧设置，超过防抖期限也不恢复，直至额外 refresh、下一次成功更新、另一次文件变化或重启。更新 models 的同类失败也有相同缓存机制。
- **复现证据**：独立临时数据目录使用真实 getContext（关闭自动下载）、真实 watcher。先正常导入并让缓存 sampleSec=7；把 backups 路径替换成普通文件制造确定性的 EEXIST 保存失败；手改 sampleSec=9，立即调用 updateSettings 写 current。250 ms 后磁盘 sampleSec=9，而 getSettings().gpu.sampleSec 仍为 7。这里失败的是备份，不是手改内容解析。没有接触用户真实配置。
- **建议修改**：确保磁盘 refresh 成功后，即使后续修改/保存失败，context 仍能获知最后有效的磁盘值；或保留 watcher 对该手改的通知资格。不要用同一个“已读取/自己写入”标记静默抑制尚未传给 context 的变化。失败时仍须保留原文件并传播保存错误。
- **缺失测试**：用实际 openStore/context 接线验证“防抖窗口内有效手改→refresh 成功→保存失败→等待 watcher”后 getter 能反映有效手改。现有测试只验证保存成功和坏 JSON 拒绝，不能发现两层缓存不同步。
- **处理（2026-09-30，第四轮修复）：已修复。** 核实成立。`JsonStore.refresh()` 读到磁盘上的新内容时，立即通过 `watch()` 注册的回调上报（与 watcher 自己重载同一内容的效果相同），发生在迁移保存或调用方保存之前，所以后面的保存失败不会再让 context 缓存漏掉这次手改；watcher 之后读到同一文本仍会跳过，不会重复上报。`openStore` 导出供测试。新增测试：备份目录被普通文件占位导致保存失败时，store 回调立即收到手改且只收到一次；`openStore` 接线：保存失败后 getter 立即、以及 300 ms 后都是有效手改。两条都在上一版代码上失败。

## 其他回归与下载失败路径

本轮独立真实 HTTP 上游探查中，正常完成、正常读取上游 500 错误事件、已有响应头后客户端 signal-only 断开、强卸载和崩溃均释放租约并清理原请求监听。前述已拿到 Response 的终止探查未观测到未处理 Promise 拒绝。bounded 的 p.then 同时安装成功/失败处理器，提前退出后底层 Promise 的迟到拒绝也被处理；监听数没有随输出块数增加。响应头前错误路径的剩余问题单独列为 CR-001。

store 的独立边界探查结果：

- 文件删除后 refresh 保留缓存，不主动重建；下一次 update 重建文件，自己的写入不触发 watcher 通知。与原有缓存/删除处理方式兼容。
- 对自造旧版本文档执行 refresh，迁移至版本 2，并生成一份原文备份。没有用真实项目配置做迁移。
- 损坏文件的 refresh/update 拒绝而不覆盖；实际 context 导入分别遇到 settings/models 损坏时也保持文件。
- **下载完成但 settings 正在被手改且损坏**：用假网络/假解压运行真实 ensureRuntime 安装流程，再让实际 JsonStore.update 写 current。结果是 runtime 状态 error/unknown，损坏 settings 保留，完整版本 b1234 已安装，缓存 current 仍为空。修复 settings 后重新执行启动检查，直接采用已安装版本并写 current，不再下载。这种“保护坏文件并明确报错、修复后重启采用已有版本”的行为可接受；不声称修复文件后本次进程会自动再执行启动检查。配置错误恢复入口仍遵守阶段 2 的用户决定。

## 实际验证记录

环境：macOS，Bun 1.3.11。只使用自造配置、假 GGUF、临时目录、临时本机上游或进程内替身；没有读取真实 data、secrets 或模型内容。

| 命令/验证 | 实际结果 |
| --- | --- |
| git fetch / fast-forward / git log / git diff | 同步并确认指定单提交范围，无自有代码修改 |
| 第一次 `bun test` | **178 pass、7 skip、1 fail**，186 tests/17 files，1596 expect，退出码 1，约 7.44 秒 |
| `bun test tests/core/scheduler.test.ts` | **26 pass、0 fail**，103 expect，退出码 0 |
| 第二次 `bun test`（探查后、提交前） | **179 pass、7 skip、0 fail**，186 tests/17 files，1598 expect，退出码 0，约 7.01 秒 |
| `bun run typecheck` | **通过**，退出码 0 |
| 内联 bun 探查：真实 HTTP 上游终止/完成 | 原背压强卸载、崩溃、客户端断开、成功、500 响应通过；响应头前崩溃仍有挂起错误 write |
| 内联 bun 探查：10,000 块长流及迟到拒绝 | 等待者峰值 1、结束 0、添加/移除 20,002/20,002；没有观测到未处理拒绝 |
| 内联 bun 探查：真实 context 导入/保存失败 | 手改保留、两种坏文件拒绝；确认 CR-013 缓存不同步 |
| 内联 bun 探查：删除、迁移、runtime 写 current | 删除和迁移符合上述结果；坏文件保护及修复后采用已有版本已验证 |

首次失败为 `tests/core/scheduler.test.ts:292` 的“crash -> crashed; next request auto-reloads once”：signal.aborted 为 true，但 signal.reason 实际为 undefined，未满足 ModelCrashError 断言。单独重跑及随后全量重跑都通过。**原因待确认**，不能把第一次失败隐藏，也不能在没有证据时归因于 macOS、Bun 或本次修改；scheduler 源码本轮没有改动，未据一次未稳定复现的现象新增确定缺陷或重开 CR-011。

7 项跳过均由 Windows 平台条件控制：真实残留进程清理、系统 ZIP 解压、Runner 整棵进程树停止，以及 process-tree 的 argv 透传、强杀 Bun 父进程、taskkill /T /F、PID 可执行文件查询。首次失败不是平台跳过项。

没有运行 build、start.bat、Windows/GPU 真机、真实下载或酒馆验收；修复方的 Windows 测试不计为本轮实际结果。全部探查结束后，临时服务、流、watcher、目录及进程内注入已清理/恢复。仅提交本报告。

CR-001 的早期错误发送和 CR-013 的失败后缓存通知修好前，本轮不能给出“通过”；阶段 1 用户试用确认关口仍保留。

## 处理结果（Claude，2026-09-30，第四轮修复）

| 意见 | 结论 |
| --- | --- |
| CR-001 剩余部分 | 已修复：所有结束路径的最后错误事件统一为有界发送（`sendFinal`） |
| CR-013 | 已修复：refresh 读到的手改立即通过 watch 回调上报 |
| 首次测试失败（scheduler「crash -> crashed」signal.reason 为 undefined） | 未能复现：Windows 上单独连跑 30 次、全量 2 次均通过。可疑点：上一版长流测试在同一进程里临时替换了全局 `AbortSignal.prototype` 的方法；该测试已改为用 `bounded()` 自带的计数（`activeBoundedWaits()`），不再修改全局原型，并补上「结束后归零」的断言。是否就是原因无法确认。 |

验证：Windows 上 `bun test` 189 通过（全量 2 次）、`bun run typecheck` 通过；三条新测试在上一版代码上确认失败。没有运行 build、macOS/Linux、GPU 真机。
