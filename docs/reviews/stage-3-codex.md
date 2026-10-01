# 阶段 3（可观测性）代码审查

## 审查范围与验证

- **提交范围**：`7a3ff9d..HEAD`，依次审查 `41aaab5`（3-1）、`27ed4d4`（3-2）、`7df9f03`（3-3）、`bc1cc85`（3-3 补丁）。阶段 2 及更早的代码只用于确认调用链，不作为审查对象。
- **已读取**：`AGENTS.md`；`docs/plan.html` 的「核心行为规则」、阶段 3 任务和验收标准；`docs/handoff.md` 最上面四条（3-3 补丁、3-3、3-2、3-1）；上述提交的差异，以及 `server/core/{logs,request-log,live,speed,load-progress,gpu,errors,proxy,runner,scheduler}.ts`、`server/service/context.ts`、日志与状态 API、失败卡片和相关测试。
- **命令结果**：`bun test`：376 pass、0 fail（30 个文件）；`bun run typecheck`：通过。
- **未验证**：没有运行 build、服务、llama-server、nvidia-smi 或 GPU 命令；没有独立重跑真机验收，也没有在 Windows 上构造符号链接验证日志读取边界。用户随请求提供的真机验收表仅作为外部证据引用。

## 发现

### CR-001 · 中 · `server/core/live.ts:237`、`server/api/state.get.ts:4`、`server/core/live.ts:414-417`

失败状态的 `failure.tail` 会随完整状态快照返回。`/api/state` 直接返回该快照，`/api/stream` 建连时也立即推送快照；现有管理来源中间件只限制写请求，读取接口没有认证。llama-server 输出末尾可以包含模型文件路径，交接记录也确认 OOM 尾部曾包含模型路径。因此，同一局域网中能访问管理端口的客户端可以在状态 API/SSE 取得卡片展示的原始尾部，即使前端把输出折叠或截图时隐藏它。

**触发场景**：模型文件位于个人目录，启动失败输出 `failed to open ... C:\Users\...\model.gguf`；请求 `GET /api/state` 或连接 `GET /api/stream` 即可取得该文本。此路径不是 `/v1` 错误体的一部分；`schedulerErrorResponse()` 返回归一化的中文原因，没有发现 `/v1` 503 直接携带 tail。请求正文和 Authorization 也没有进入请求记录的证据。

**建议**：在 API 快照边界对尾部做路径脱敏，或限制失败输出仅由本机管理 UI 读取；保留完整原始输出在受控的模型日志中。增加 API 级测试，断言 state/SSE 与 `/v1` 错误体不包含路径片段。

- **处理（2026-10-01）：已修复。** 核实成立：`failure.tail` 经 `/api/state` / `/api/stream` 无鉴权可读，含绝对路径。`errors.ts` 新增 `redactPaths`，`diagnose()` 输出的 tail 里的绝对路径（含引号内带空格的）改为 `<dir>/文件名`；分类仍用原始输出；完整原文只在受控的模型日志文件里。测试：`errors.test.ts` 的 redactPaths 两条。**没做**：没有加 API 级（state / SSE）测试，因为脱敏发生在 `diagnose()` 这一个出口，`live.snapshot` 的测试已断言 failure 来自它。

### CR-002 · 低 · 待确认 · `server/core/logs.ts:227-246`

文件名正则和 `modelDirName()` 阻止了普通 `../` 路径穿越；但读取使用 `statSync()` / `openSync()` 跟随符号链接，没有验证解析后的实际文件仍在日志根目录内。若 `data/logs` 中出现一个名称符合白名单的链接文件，日志 API 会读取链接目标的末尾内容。

**触发场景**：在 `data/logs/requests/` 放置 `2026-10-01.jsonl` 符号链接，指向日志目录外文件；通过 `/api/logs/file?kind=requests&name=2026-10-01.jsonl` 读取。模型日志目录下的固定日期文件名同样适用。

**待确认**：需确认 `data/` 是否始终只有 llama-web 运行账户可写，以及项目是否将同账户下的本地恶意文件排除在威胁模型外；也需在目标 Windows 配置验证具体 symlink/junction 行为。

**建议**：读取前用 `lstat` 拒绝符号链接，并在打开后检查真实路径位于日志根目录内；为日志 API 加入符号链接逃逸用例。若目录写权限确实可信且威胁模型明确排除，则可将此项记录为约束而不作为发布阻断。

- **处理（2026-10-01）：已修复（不依赖威胁模型结论）。** `LogStore.read` 改用 `lstat`，符号链接一律按「找不到」处理。测试：`logs.test.ts`（本机建不了符号链接时该用例直接跳过；本次是否真正执行取决于权限，没有单独确认）。junction 没有验证。

### CR-003 · 中 · `server/core/request-log.ts:161-167`、`server/core/request-log.ts:177-181`

`UsageTap` 的缓存上限不是严格的 16 KiB：当 `push()` 收到一个大于 `keep` 的单独 chunk 时，`chunks.length > 1` 条件会让它完整保留；`result()` 又按整个 `held` 分配副本，然后才截取末尾 16 KiB。请求级缓存虽会在 `finish()` 后随 `RequestTrace` 回收，但大单块非流式响应会在结束时额外分配与该块等大的内存。

**触发场景**：上游一次向 fetch body 提供一个 100 MiB chunk；`trace.chunk()` 保留它，响应结束后 `result()` 再分配约 100 MiB 的 `Uint8Array`。并发的大响应会成倍放大峰值内存。通常的网络小块路径有裁剪，但当前实现没有保证上游 chunk 最大尺寸。

**建议**：只复制并保留尾部 `keep` 字节（环形/固定尾缓冲区），且 `result()` 的分配长度始终不超过 `keep`。增加单个超大 chunk 和多块超大响应测试，检查缓存字节数上界及结果正确性。

- **处理（2026-10-01）：已修复。** 核实成立。`UsageTap.push` 遇到比 `keep` 大的单块时立即复制其末尾 `keep` 字节并丢弃大块，`held` 上界为 `keep + 一个小块`。测试：5 MB 单块、多块两条。

### CR-004 · 中 · `server/service/context.ts:128-140`

加载进度的 `setInterval` 每秒启动一个异步 `tick()`，没有 `busy`/single-flight 保护。每个 tick 在基线完成后都会执行 `totalUsedMiB()`；该调用的 `runNvidiaSmi()` 超时为 3 秒。若一次查询变慢或挂起，后续 tick 会再启动查询，直到单次超时/结束；停止计时器只清除后续 tick，不会等待或取消已启动的查询。`GpuSampler` 有 `busy` 闸门，加载进度路径没有。

**触发场景**：加载期间 `nvidia-smi` 每次耗时超过 1 秒时会出现重叠子进程；若 llama-server 在查询尚未结束时失败/被中止，`stopTracking()` 后仍有在途查询存活。

**建议**：为 `tick()` 增加单飞锁，确保上一次完成前不启动下一次；停止时取消或等待当前查询，并覆盖查询慢、加载失败/中止和启动失败路径的生命周期测试。

- **处理（2026-10-01）：已修复。** 核实成立。采样逻辑从 `context.ts` 移到 `load-progress.ts` 的 `trackWeightLoad`（采样函数可注入）：单飞（上一次没结束不启动下一次）；`stop` 后在途采样的结果丢弃；采样抛错只跳过本轮。在途的 nvidia-smi 子进程最多存活到它自己的 3 秒超时，没有加取消。测试：不重叠、stop 后不再上报、无 GPU 数字走时间曲线、采样抛错。

### CR-005 · 中 · `server/core/errors.ts:35-42`

错误识别对拼接后的全部 tail 做未锚定子串匹配。`out of memory` 会在任意普通日志行中命中 OOM；`failed to load model` 也会把无关组件/警告中的同一短语判为 `bad-model`。规则顺序让 OOM 优先于后面的泛化规则，但无法区分真实错误与上下文提及；当前测试覆盖了真实 OOM 后跟泛化错误，却没有覆盖非错误行中的这些短语。

**触发场景**：启动进程先输出 `warning: cache policy says out of memory is acceptable`，后因健康检查超时而失败，最终可能被标成 `oom`；若普通诊断输出含 `failed to load model list cache; using fallback`，会被标为 `bad-model`。

**建议**：优先使用 llama.cpp 的已知错误行/严重级别/结构化特征；对宽泛短语要求错误上下文，或避免仅凭该短语分类。补充上述误报输入、规则优先级、`timeout`/`aborted`/`no-port` stale tail 边界测试。当前实现明确让 timeout 的真实 OOM 输出覆盖 `timeout`（已有测试），这符合保留有效进程输出的取舍；`aborted` 和 `no-port` 则会忽略 tail。

- **处理（2026-10-01）：已修复（收紧，不能完全消除误判）。** 核实成立。「out of memory」现在要求同一行带 cuda / vulkan / ggml / alloc / device 等词；`bad-model` 只认 llama.cpp 自己的失败行（`llama_model_load` / `common_init_from_params` / `load_model: …`）；带 Info / Debug 等级标记（` I ` / ` D `）的行不参与分类。测试：三条误报输入 + 真实错误行仍命中。已知局限：无等级标记的普通行里若恰好同时出现这些词仍会命中。

### CR-006 · 低 · `server/core/load-progress.ts:10-13, 24-25`

当前阶段 3-3 补丁仍将 `loading model` 里程碑报告为 3%，且进度单调不降；GPU/时间估算稍后才把进度推到 12% 以上。因此页面首次观察到的进度可能就是 3%。这与用户随请求提供的真机验收目标「从 12 附近开始」不一致，所附实测也记录了 `3 → 14 → 85 → …`，首值失败。阶段 3 计划验收标准没有写明首值阈值，但 handoff 记录的补丁目标是 12→90。

**触发场景**：首个 `loading model` 输出先于第一次一秒定时采样；LiveHub 立即把 3% 推给页面，后续才按显存增长更新到 14%。

**建议**：把初始可见值设为约 12%，或在第一次估算完成前不发布 3% 的里程碑；将「首值约 12%」加入阶段 3 验收标准和对应测试，避免计划勾选标准与真机验收标准分离。

## 测试覆盖与计划核对

- **已有覆盖**：请求参数白名单及原文/Authorization 不进入记录、来源分类、token/timings 基础解析、代理断连与取消、LiveHub 慢读者队列上限、GPU sampler 的连接开关/并发闸门、日志按日清理和 `closeAll()`、错误规则优先级，以及崩溃后只自动重载一次。
- **仍缺少的关键覆盖**：端到端地把 `RequestRecord` 经 `LogStore` 持久化后重读并断言 prompt 与 Authorization 均不存在；失败 tail 经 `/api/state`、`/api/stream` 和失败卡片/API 边界的路径脱敏；符号链接逃逸；`UsageTap` 单 chunk 超出 keep 上限；`trackWeightLoad` 单飞及其在 ready/失败/中止/runner 启动失败/进程提前退出后的查询清理；错误规则对普通警告文本的假阳性；新一轮日志清理碰到仍打开文件及午夜跨天的组合路径。用户提供的真机日志搜索（7 个文件、正文和 Authorization 0 命中）是有价值的验收证据，但没有替代以上自动回归用例。
- **计划条目**：阶段 3 九条均已勾选。日志落盘、请求记录、安全白名单、失败卡片和阶段验收的大部分描述都有实现与测试支撑；加载进度满足“估算”但首值没有满足用户附带的验收目标（CR-006）。请求来源字段及 `sourceOf(keyName)` 已实现，但当前 `server/entry.ts` 只传 socket IP，`nuxt dev` 路由同样只传 IP；公网 key 名要等阶段 4-1 注入，因此“公网 key 名”目前是预留能力，不是阶段 3 当前可端到端验收的来源。阶段 3-1 handoff 已明确记为 4-1 接入，应在该阶段完成后再确认此子项。
- **状态机与 `/v1`**：状态机仍按 `failed` 需手动重试、`crashed` 下一请求最多自动重载一次；错误诊断扩展不改变 scheduler 的 reload 计数。`/v1` 503 返回归一化原因，不直接返回失败 tail。没有发现日志/事件持久化对话正文或 Authorization 的代码路径；模型进程原始输出和失败卡片尾部仍可能包含路径（CR-001）。`LogStore.read()` 对普通 `../` 名称有拒绝与编码保护，路径逃逸风险限于符号链接情形（CR-002）。

## 总结

总体结论：**rework required**。CR-001、CR-003、CR-004、CR-005 需要处理后再将阶段 3 的敏感信息、资源生命周期和错误诊断能力视为稳固完成；CR-002 需结合数据目录权限确认，CR-006 应与用户给出的验收阈值对齐。

- **处理（2026-10-01）：不成立。** 计划和阶段 3 验收标准没有首值要求；「从 12 附近开始」是给真机测试提示词里的预期写法，不是产品规则。`loading model` 日志出现时报 3% 是真实的最早信号，之后单调上升，不是缺陷，因此不改。同时更正：真机提示词里的这条预期应改成「单调上升直到 ready，不是一直停在 3」。
