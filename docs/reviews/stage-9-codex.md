# 阶段 9 交叉审查闭环核对 · Codex · 2026-10-13

## 结论与边界

**整体结论：rework required。** r2 的 CR-010～CR-021 原失败条件在 HEAD 上均已有修复；但本轮确认一个 major（CR-022）与两个 minor（CR-023、CR-024），不能据此把阶段 9 的交叉审查判为通过。Windows/CUDA/WDDM/多卡真机验收也不能由本轮软件测试替代。

审查基线：`0e8c58296fede93c87b408c11f55138d86799b05`。读取了 AGENTS.md、阶段 9 任务/验收标准、核心行为规则、会话指南及 r1/r2 报告。r2 检查的是当时未提交工作区；本轮通过 `git log c69b138..HEAD` 和相关路径的提交差异定位这些修复最终进入 HEAD 的位置，没有把 r2 的旧工作区当成一个修复提交。

本轮是独立闭环核对，不声称恢复了原 GPT 审查者的运行时会话。工作区原有阶段 11 未提交改动不在审查范围，没有评价或修改它们。重叠的实现/字典通过 `git show HEAD:<path>` 读取；第二、第三轮专项测试使用从 stdin 加载的 Bun plugin，将仓库内 TypeScript 模块加载为 HEAD 内容。composable 的函数体复现也直接读取 HEAD。没有切分支、stash、提交、推送或修改实现/测试/计划/交接；唯一保留的新文件是本报告。没有读取真实 `data/secrets.json`。

## 后续提交核对

`c69b138..HEAD` 共 28 个提交，影响阶段 9 调用链的主要变化如下；其他发布脚本、版本、README、架构图及记录提交仅核对了范围，没有扩展为这些功能的审查。

| 提交 | 与闭环相关的变化及核对结果 |
| --- | --- |
| `b49df7a` | r1/r2 修复集中提交：全部分片布局、mmproj host/device、严格手动确认、等待者动态重判、float32 分卡、实测 key、启动拒绝反馈、Mac watchdog 文案、row/tensor 未建模提示。见逐项判定。保存检查只增加了 `fresh` 参数通道，没有修改实际保存调用，见 CR-023。 |
| `cd7c365` | 阶段 10 外部上游及独占本机：本地加载仍通过 Scheduler；独占阻断叠加在阶段 9 admission 之前。空 model 仍走本地 resolveTarget。 |
| `039eabd`、`76fe03e`、`f5f5f2b`、`6e14209` | 公网端口识别、前缀冲突、独占提示与运行记录等后续调整；没有引入绕开本地 admission 的加载路径。 |
| `47fd2ef`、`df5c658`、`dd3dd2f` | 外部转发参数、手动启动/停止外部服务。外部进程不进入本地 Runner/PidRegistry，按决定 56 的资源边界处理。 |
| `6e33dc6` | multi-load 测试固定运行库，不再取决于测试机 GPU；没有改变产品 admission。 |
| `4712bb3`、`3fce7f4`、`f080f11`、`8f1f2b6` | 阶段 11 locale 配置/字典接线、代理错误文案、语言入口变化。本轮只核对其对阶段 9 DTO、拒绝反馈和路由的影响，没有审查翻译工作本身。Mac watchdog 的内存文案仍存在。 |
| `5da4353` | admission 和等待卸载之后重查独占 holder，代理区分 `machine_exclusive`；没有回退 r2 的来源/确认重判或原显存拒绝逻辑。 |
| `0e8c582` | 计划记录仍保留阶段 9 未闭环状态；本轮没有改动该状态。 |

## r2 逐项判定（沿用原编号）

“已解决”针对原报告的失败条件；不是对所有硬件、参数或跨版本组合的保证。关闭项的严重程度沿用原报告，不计为当前 actionable finding。

| 编号 / 原严重程度 | HEAD 判定 | 当前证据和触发条件核对 | 建议 |
| --- | --- | --- | --- |
| CR-010 / major | 已解决，未发现回归 | `server/core/model-facts.ts:59` 读取全部后片并合并 layout；缺片/损坏标 partial，`server/core/memory-estimate.ts:217` 不把 partial 当完整布局。分片测试通过。 | 关闭原意见；真实分片 CUDA 加载未测。 |
| CR-011 / major | 已解决，未发现回归 | `server/core/model-check.ts:75` 按最终 argv 顺序解析视觉 offload；`:109` 传给估算器；`server/core/memory-estimate.ts:409` 关闭 offload 时放 host。开关优先级/池分配测试通过。 | 关闭原意见；真实 CPU 视觉峰值未测。 |
| CR-012 / major | 已解决，关联 CR-019 也已解决 | `server/core/memory-estimate.ts:249`～`:268` 用同一 offload 窗口处理重复层及输出层；原四层双卡与部分 offload 边界测试通过。 | 关闭 layer 公式原意见；不把它推导为 row/tensor 已建模。 |
| CR-013 / major | 已解决原确认缺口 | `server/core/scheduler.ts:571` 只有 `confirmed === true` 或有效请求 waiter 才接受风险，undefined 不再豁免。内部 `restart/startLast` 虽仍不传确认（`server/core/model-ops.ts:53`、`:76`），现在也被该条件拦截。start/retry/setup 的明确确认传递保留；严格 undefined、risky/unknown 拒绝测试通过。 | 关闭原意见；另修 CR-022 的配置变化竞态。 |
| CR-014 / minor | 已解决，未发现回归 | `app/composables/useMemoryChecks.ts:23`、`:33`、`:45` 用 dirty 丢弃旧响应并合并补查。原集合变化/在途补查测试通过。 | 关闭原在途丢重算意见；探针读数新鲜度单列 CR-023。 |
| CR-015 / minor | 已解决原夹具问题 | `tests/service/multi-load.test.ts:188` 开始的 mlock 用例保留 Windows 默认继承断言，然后清空 global extraArgs 做对照并恢复。service 套件通过；本机没有执行 Windows 分支。 | 关闭代码/夹具意见；Windows 实测不在本轮证据内。 |
| CR-016 / minor | 已解决 r2 残留文案 | HEAD `server/core/proxy.ts:189` 为 darwin/watchdog 选内存文案；HEAD `i18n/zh-CN.ts:50` 无显存字样。`server/service/model-check.ts:104` 返回 acceleratedLayers。Mac 分支与原文案路径静态核对。 | 关闭原意见；真实 Mac watchdog/API/UI 未测。 |
| CR-017 / minor | 已解决原同毫秒问题 | `server/core/routing.ts:38` 用 useSeq 打破同毫秒平局；Scheduler snapshot 保留该序号。路由与 Scheduler 回归通过；按 modelId/profile 定位。 | 关闭原同毫秒意见；系统时间回拨不是本项验证范围。 |
| CR-018 / major | 已解决原等待者竞态 | `server/core/scheduler.ts:570`～`:589` 在 admission await 后读取当前 waiters。原“请求取消后只剩未确认手动调用”与“确认调用在 await 期间加入”两个测试通过。 | 关闭原意见；不代表配置也已纳入同一并发边界，见 CR-022。 |
| CR-019 / major | 已解决原三卡数值边界 | `server/core/model-check.ts:155` 保留原始比例；`server/core/memory-estimate.ts:239`～`:245` 对份额累加、归一化、层位置按 float32 转换。三卡 `1,2,7` 回归通过。 | 关闭原 b11146 数值语义意见；实际运行库/三卡占用未实测。 |
| CR-020 / major | 已解决原 A→B 运行库/同路径模型更新复现 | `server/service/model-check.ts:90`～`:91` key 加入 runtimeKey/ref 和主模型、视觉、草稿 stamps；`server/core/model-facts.ts:79` stamp 遍历全部分片。同路径文件替换后回到 formula 的 service 测试通过；不同运行库身份按 key 代码核对。 | 关闭原失败条件。相同 custom ref/label 的原地二进制替换、保留 size/mtime 的替换仍待确认支持边界，不能宣称内容哈希级失效。 |
| CR-021 / minor | 已解决原“完全没有反馈”路径 | `server/core/live.ts:200` 透传 tier；`app/composables/useModelStartFeedback.ts:75` 消费 manual no-room，清 pending 并开 guard。原 accepted→unconfirmed 的反馈测试通过。 | 关闭原缺消费者问题；新增的消费者错误匹配另列 CR-024，避免混淆原失败条件。 |

## 当前新发现

### CR-022 · major · admission 检查的配置与实际启动配置不一致，可把新 nofit 配置按旧 ok 放行

- **位置：** `server/service/admission.ts:42`～`:45`，`server/service/model-check.ts:68`～`:86`，`server/service/context.ts:428`；可并发修改的入口 `server/api/models/[id]/profiles.post.ts:59`。
- **问题/违反契约：** admission 读取旧 model 并生成 preview 后等待文件/内存探针；等待期间配置可以保存。最终 launch 又从 `getSettings()/getModels()` 生成当前 plan，却没有比较它与已检查的 argv/文件/运行库，也不重新 admission。阶段 9 要求真正加载前检查最终参数，当前检查不能保护实际启动参数；manual `confirm:false` 和请求触发均受影响。
- **触发场景：** 多开开启，目标启动排到 admission；原方案 ctx=1024、检查可放下。内存探针未返回时，在另一管理窗口保存同一方案的新 ctx（`restart:false` 即可，save 允许修改排队方案，只有改名/删除检查 busy）。探针返回旧配置的 ok 后，launch 使用新配置。新 ctx 已超预算，但不会返回 no-room，而进入 Runner。参数、模型文件引用、全局默认或运行库变化同样需要绑定检查身份。
- **独立复现：** 从 HEAD 的现有 service 夹具提取初始化，使用真实 context、ModelOps、Scheduler、admitTarget/checkProfile、launcher；仅将 Runner.start 替换为捕获 argv 的假进程、探针替换为可控 Promise。ctx=1024 时发起 `ops.start(M,{confirmed:false})`，挂住探针，调用真实 `updateModels` 将 ctx 改为 67108864，释放探针。输出：

  ```json
  {"result":{"ok":true},"state":"ready","spawnCtx":"67108864","currentTier":"nofit","currentTotal":262204.1898826294}
  ```

  输入为八层合成 llama GGUF、设备 free=22000 MiB、系统 available=60000/total=64000 MiB。超大 ctx 仅用于明确跨过预算。`ready` 是假进程结果，证据是**真实 launcher 已把未经当前检查的 argv 交给 Runner**，不是声称真实模型能加载成功。复现通过 `updateModels` 模拟保存落盘；未运行 HTTP 保存端到端或真实 OOM。
- **影响：** 放不下的新配置绕过最终资源拒绝，可能挤占其他在线模型资源；测量还会使用旧 admission.statsKey 记录新启动的结果，污染旧形态统计。这是配置版本竞态，不是再次报告 CR-013 的 undefined 确认缺陷，也不是外部空闲量自然波动。
- **建议：** 将 admission 与不可变 launch plan/配置版本绑定。配置变化时重新检查并重新判断当前 waiter 授权；确认最终运行库、设备、argv、文件身份与检查一致后才启动。测量 key 必须对应实际 plan。补一个挂住探针、并发保存参数后拒绝启动的集成回归。
- **处理（2026-10-13）**：已修复，分三步完成。① admission 绑定所检查方案的 key，配置变化时重新检查（`admissionIsCurrent`，过期最多重试 3 次，超限拒绝原因为新增的 `config-changed`）；② 启动清理等待移到 admission 之前，launch 在 plan 前同步复核绑定（`admissionStillBound`），不一致抛 `LaunchConfigError('config-changed')`，中英文案走 i18n；③ 无法证明身份时按过期处理。第 3 轮判关闭。`/v1` 错误码约定没有改，仍是 503 `insufficient_memory`。

### CR-023 · minor · 保存前重新检查仍沿用一分钟设备空闲缓存

- **位置：** `app/components/ProfileForm.vue:254`，`app/composables/useMemoryChecks.ts:32`，`server/service/model-check.ts:80`，`server/core/devices.ts:81`。
- **问题/违反契约：** `refreshCheck(fresh=false)` 有发送 fresh 的能力，但 `trySave()` 仍调用 `refreshCheck()`，所有调用都没有传 true；共享检查的 force 也只更新前端请求，不传 fresh。计划 9-4 承诺保存前取最新读数，r2 的探针新鲜度待确认项仍未关闭。`b49df7a` 只加了参数通道，交接中的“保存前带 fresh:true”不符合 HEAD 实际调用。
- **触发场景：** CUDA 设备列表在 0 秒缓存 free=1000 MiB，15.001 秒外部程序使 free=100 MiB。点击保存或在线集合触发 force，后端普通 list 仍返回 1000；可能错误显示 ok，漏掉保存风险确认。直到缓存到期或真正 admission 才重新采样。
- **独立复现：** 真实 DeviceProbe 配合构造的 `Available devices:` 输出及注入时钟，结果：

  ```json
  {"first":1000,"cached":1000,"refreshed":100,"runs":2}
  ```

- **影响/边界：** 保存提示不可靠；`admitTarget` 显式 fresh:true，因此本项本身不是最终 nofit 拦截的绕过证据。刷新与旧在途 probe 的去重边界未另行验证。
- **建议：** 保存前调用 `refreshCheck(true)`；共享 force 若承诺重取当前资源，也应透传 fresh:true。补调用方到探针的接线用例，不能仅测试 DeviceProbe 的 refresh 能力。
- **处理（2026-10-13）**：已修复。`trySave()` 改为 `refreshCheck(true)`，force 请求带 `fresh: true`，补接线测试。第 2 轮判关闭。

### CR-024 · minor · 旧方案拒绝事件会清除新方案的启动等待并打开错误方案确认框

- **位置：** `app/composables/useModelStartFeedback.ts:59`～`:66`、`:75`～`:77`。
- **问题/违反契约：** CR-021 新增消费者只用 modelId 清 pending，没有像 state 消费分支一样检查 profile/动作时间。30 秒内的 manual no-room 即使属于另一方案的旧操作，也能结束新操作的反馈，并让 guard 指向旧方案。
- **触发场景：** 旧方案 default 的后台启动被拒，SSE 事件尚未送到；用户已对同模型 other 发起新启动。旧 no-room 到达后清除 other 的 pending，并弹 default 的“仍然启动”。新启动失败时反馈已丢失；用户确认弹窗则会再次请求旧方案。
- **独立复现：** 执行 HEAD 原 composable 函数体，使用真实 Vue ref/watch/effectScope。begin/accepted `m1:other` 后发送近期 manual no-room/unconfirmed `m1:default`，得到 `before=["m1"]`、`after=[]`，guard 的 `profile="default"`。未运行真实浏览器/HTTP/SSE。
- **建议：** 活动事件携带 job/attempt 身份，或至少在存在 pending 时按 profile、after/动作时刻匹配再清理。保留内部切方案/重启没有显式 pending 时的通知能力；补跨方案晚到事件回归。
- **处理（2026-10-13）**：已修复。存在 pending 时按 profile 且 `e.id > after` 匹配，无 pending 时保留原通知，补跨方案晚到事件回归。第 2 轮判关闭。

## 阶段 9 点名范围的核对

| 范围 | 本轮结果与证据 |
| --- | --- |
| 多进程生命周期/残留清理 | `Runner.reservePort` 串行分配并立即预留（runner.ts:235），registry add/remove 为多记录同步原子写；`stopAll` 遍历自有进程。POSIX 分离进程组、Windows `taskkill /T /F`；residue.ts:67 以后重查 birth/exe/真实 runtime 边界，不按进程名广杀。Scheduler shutdown 和 context 的 runner.stopAll 接线保留。残留纯测试通过；真实 Runner 端口测试受沙箱阻止，不能宣称本轮进程树验收通过。 |
| 并发加载/卸载 | FIFO pump 全局串行，共享 waiter、重复停止、draining、超时、取消、单模型崩溃和 auto reload 有核心回归。`watchdog` 采样后重取候选，`Scheduler.unload(...idleOnly)` 在同 tick 检查 lease 再 draining。发现 CR-022：配置版本未进入检查/启动原子边界。 |
| 公网能否绕过 admission | `handlePublic` 只开放 /v1/*、校验 key 后进入同一 `proxy.handleV1`；HEAD proxy.ts:655 的非流请求及 :428 的等待流都 acquire 同一 Scheduler。请求 meta/headers 不改变资源判断，confirm 不是 /v1 的权限参数。外部前缀路由不启动本地进程，空 model 不选外部上游。未发现来源特有绕过；CR-022 可影响所有来源。公网真实 HTTP 套件受沙箱阻止。 |
| 预估偏低的失败路径 | Runner 的提前退出/超时拒绝 ready 并 stop；Scheduler 将加载失败置 failed、拒绝等待者，失败不清其他实例。context.ts:501 防止采样时已退出仍 ready；加载期 watchdog 会传 stopCause，等待者获 no-room。HEAD proxy.ts:319 的实际加载失败为 503 model_load_failed，资源拒绝 :324 为 503 insufficient_memory。流式等待已经发出 200 SSE 后以 error 事件收尾，不能称其后来变成 HTTP 503。真实压力、驱动失败及回收速度未测。 |
| 无 model 的路由/状态机 | routing.ts:53 先最近使用 ready，再 loading，否则 no-model；useSeq 解决同毫秒，ID/profile 不依赖显示名；release/acquire 都 touch。手动从未被请求使用的 ready 排在已使用模型后。draining/failed/crashed 不作无 model 候选；外部上游不作候选。路由与单开/多开核心测试通过。没有扩展成全部旧客户端的端到端兼容验收。 |

## r2 待确认项与阶段验收限制

1. **实测失效条件：** 原运行库 A→B/普通文件更新已修复（CR-020）。同一 custom ref/label 的二进制原地替换没有 binary stamp；size/mtime 相同的文件替换也不改变 fileStamp。此类原地修改是否属于支持的更新方式**待确认**，不伪称有内容哈希保证。另有已确认的检查/启动版本错配 CR-022。
2. **采样外部干扰：待确认。** memoryEvents 能拒绝本服务状态变化期间的差值，不能证明外部应用未释放资源。Windows WDDM 噪声、compute/fixed 向下替换的可信度、本机真实内存压力未验证，不新增猜测的 OOM 数值意见。
3. **row/tensor：常规多活跃池的误报 ok 已缓解，资源模型仍未验收。** model-check.ts:232 将 layer 估算中超过一个 separate pool 的组合标 unknown（已 nofit 保留），preferMeasured 保留 unknown，回归通过。这是保护范围收窄，不是 row/tensor 逐卡建模。少量 offload 导致 layer 公式只有一个活跃池时该分支不执行；实际 row/tensor 是否仍使用其他卡**待确认**，本轮没有硬件或对应上游执行证据，不作为确认缺陷。
4. **重新检查探针新鲜度：仍未解决，确认后列为 CR-023。** 最终 admission 的 fresh 与展示/保存检查应分别评价。

阶段 9 计划中的 CUDA 公式/固定开销校准、WDDM 实测、Windows 多进程退出/残留、真正多卡 UI 等仍未完成的硬件任务，本轮没有补做或打勾。9-2 的“其他在线模型取实测”项已注明使用设备实际 free 的替代解释，本轮没有把未勾选本身转换成一个代码缺陷。

## 实际验证

| 命令/方式 | 实际结果 |
| --- | --- |
| `git log c69b138..HEAD`、相关路径 `git log -p` / `git show` | 定位 28 个后续提交，审查 HEAD 及上述相关调用链；未切分支。 |
| `bun test tests/core/{scheduler,scheduler-multi,model-ops,memory-estimate,model-check,model-facts,vram-stats,watchdog,routing,runner,residue}.test.ts`（实际以各路径逐个传参） | **184 pass / 2 skip / 11 fail，exit 1**。runner 监听 127.0.0.1 报 EPERM，后续端口分配报告 no-port。失败不能当成产品回归，也不能报通过。涉及文件及运行依赖不含原有 dirty 实现。 |
| 从 stdin preload HEAD 模块，再跑上面的核心范围去掉 runner、加入 service/multi-load、app/model-start-feedback、app/memory-checks-composable、core/public-entry | **223 pass / 1 skip / 6 fail，exit 1**。public-entry 的 Bun.serve 端口 0 无法监听，报 EADDRINUSE；结合前一轮 EPERM，当前沙箱不能完成该 HTTP 验证。 |
| 同一 HEAD preload，去掉 core/public-entry 的 13 文件专项 | **210 pass / 1 skip / 0 fail，exit 0**，211 项、789 断言。service 单开试图启动时仍因 no-port 而失败；该用例只断言不是资源拒绝，不能用其通过声称真实单开启动成功。 |
| `bun --eval`，隔离 context + 合成配置/GGUF + 可控探针 + Runner 替身 | 确认 CR-022 的新 ctx argv 获得启动，当前配置重新检查 nofit。正常退出、context shutdown，夹具删除。 |
| `bun --eval`，HEAD composable + Vue、DeviceProbe 注入时钟 | 确认 CR-024 的错误 profile 清 pending/弹框；CR-023 读数 1000→缓存1000→fresh100。effectScope 关闭，没有真实浏览器或服务监听。 |
| `git diff --check`（写报告前） | exit 0；未修改既有 dirty 文件。报告写入后另做最终状态检查。 |

独立脚本仅在内存中转译/执行，没有保存成测试文件。调试过程中有脚本失败：误引用不存在的 `ctx.gpu`、Bun 不支持该长 data URL 导入、静态 import 转换正则错误、spawnSync 绑定冲突，以及最初把参数 flag 当作 overrides key、探针样本文本缺标题。均在更正后重新执行；失败/无效尝试不算验证通过。产生 context 的尝试执行 shutdown 并删除合成夹具；没有真实 llama-server/GPU 进程。本轮没有留下临时脚本或服务器。

**未运行：** 全量 bun test、typecheck、build、Windows/CUDA/WDDM/多卡/真实 Metal 加载、真实 OOM、安装包退出、浏览器保存/启动反馈、真实公网隧道。typecheck/build 会面对原有阶段 11 工作区及生成产物，本轮没有把它们当成 HEAD 的验证或主动扩展写入范围。只对上述软件范围给出证据，不引用历史真机结果作为本轮通过项。

**最终判定：rework required。** 需先解决 CR-022；CR-023、CR-024 也应处理，并继续如实保留硬件/未建模组合的验收限制。

## 第 2 轮 · 2026-10-13

**结论：rework required。CR-022 部分修复、仍未关闭；CR-023 和 CR-024 已关闭。** 本轮沿用原编号，没有修改前文。本轮只追加本节，没有修改实现、测试、计划、交接，没有提交或切分支。

审查对象为用户指定 worktree 中的独立提交 `e117677b3de24068ce1b6572243315567857f493`，父提交确为 `0e8c58296fede93c87b408c11f55138d86799b05`。用 `git -C <worktree> show e117677` 检查全部 10 个改动文件，所有测试和独立脚本在该 worktree 运行，使用其 node_modules；开始与收尾 `git status --short` 均为空。主仓库原有其他改动不在本轮范围。以下文件行号均指 e117677。

### 各条闭环判定

| 编号 / 原严重程度 | 判定 | 独立复核证据 |
| --- | --- | --- |
| CR-022 / major | **部分修复，仍未关闭** | 原先挂住内存探针、期间修改 ctx 的场景现在重查两次，返回 no-room/memory，Runner 未被调用；但校验之后等待启动清理的场景仍会使用新 ctx 启动，见下文。 |
| CR-023 / minor | **已关闭** | 执行实际 ProfileForm 的 refreshCheck/trySave 函数体及实际 useMemoryChecks，接入真实 DeviceProbe 的注入时钟/读数。普通请求 body 为 `{profile:"p"}`；force body 为 `{profile:"p",fresh:true}`；保存 body 也含 fresh:true。设备 free 从 1000 改为 100 后，强制重算发布 100，保存读取 100，探针共调用 3 次。新接线测试通过。 |
| CR-024 / minor | **已关闭原跨方案触发条件** | 执行实际 composable + Vue 响应式：当前 `m1:other` pending 收到 `m1:default` 的拒绝，pending 保留、guard 数为 0；收到 other 的拒绝则清 pending、guard 指向 other；随后无 pending 的 default 拒绝仍正常通知。两条新增测试通过，原成功/失败反馈回归通过。 |

### CR-022 剩余缺口 · major · 校验通过后仍会等待 cleanupDone，再读取另一份配置

- **位置：** `server/core/scheduler.ts:595`、`:623`；`server/service/context.ts:427`～`:429`。服务开放请求的路径为 `server/entry.ts:33`～`:39`，Nitro 插件 `server/plugins/app.ts:5`～`:8` 也没有等待清理结束。
- **问题：** admissionIsCurrent 只证明它返回时的配置符合旧 admission。随后 Scheduler 调用 launcher；launcher 先 `await cleanupDone`，再用当时的 getSettings/getModels 生成 planLaunch。清理尚未完成时，这个 await 是实际长等待，不只是一个已解决 Promise 的微任务。服务已监听，管理请求可以在其间保存参数，实际启动计划仍与通过的 admission 不一致。共享 key 没有被作为不可变 launch plan 消费，也没有在该等待后重查。
- **触发场景：** 上次有残留进程，启动清理正在做身份探测/结束进程树；用户已经能发起本地启动请求。旧 ctx=1024 的 admission 和身份复核均通过，Scheduler 进入 loading，launcher 等待清理。另一个管理操作保存 ctx=67108864；清理结束后 launcher 使用新 ctx，绕过新配置本应得到的 nofit。无须进程名误杀、恶意文件或无效配置。已完成清理后的正常时序不是这个复现的前提。
- **可达性证据：** entry 立即创建监听器，没有 await cleanupDone；Nitro init 也只创建 context 和注册 close hook。只有 launcher 在这里等待 cleanupDone。因此“清理完成后才允许所有请求”的外部屏障不存在。真实残留清理的 PowerShell/进程停止可耗时；本轮没有启动真实残留进程来制造延迟，而是控制现有异步依赖。
- **独立复现：** 使用真实 context/ModelOps/Scheduler/admitTarget/admissionIsCurrent/currentLaunchKey/launcher、与上一轮相同的八层合成 GGUF 和预算。仅将 runStartupCleanup 替换为可释放的 Promise、Runner.start 替换为捕获 argv 的假进程、内存读数注入为构造值；没有替换校验器或 launch 函数。等待实际 loading 事件（证明校验已通过），通过真实 updateModels 保存大 ctx，再释放清理。输出：

  ```json
  {"case":"afterCheckBeforePlan","result":{"ok":true},"spawnCtx":"67108864","currentTier":"nofit","state":"ready"}
  ```

  ready 属于假进程；证明的是**真实 launcher 将新 ctx 交给 Runner**。不是声称真实巨量上下文加载成功，也没有运行 HTTP/GPU/OOM。
- **影响：** 原 CR-022 的核心问题仍成立：新的放不下配置能按旧 ok 启动，旧 statsKey 仍可被用于新启动的测量记录。应继续阻塞本项闭环。
- **建议：** 把启动清理等必须等待的前置条件移到 admission 之前；并使最终校验与 plan 的消费形成同一边界：检查和启动使用同一不可变配置/最终计划，或在最后等待后重新绑定并复核，变化则回调度循环重查资源与 waiter 授权。只再加一个 key 比较、随后仍异步读取另一份配置，不足以解决整个缺陷。补“清理未完成，身份校验后保存，再放行清理”的接线回归。

### 调度循环及用户可见回归核对

本轮独立执行真实 Scheduler，使用可控 admissionCurrent Promise 和假进程，未修改文件；各实例结束后 shutdown：

| 场景 | 实际结果 |
| --- | --- |
| admissionCurrent 连续返回 false，请求/已确认手动调用分别执行 | 各调用 admission 4 次、launch 0 次，返回 no-room/unknown；事件 manual 分别 false/true。计数为最多 3 次重试，第 4 个过期结果拒绝，循环有界。 |
| 校验 await 期间请求取消，只剩 confirmed:false 手动 waiter | 请求 cancelled，手动 no-room/unconfirmed，launch 0 次。 |
| 上述场景的第一次身份结果为 stale，继续重新检查后才判断授权 | admission/current 各 2 次，仍返回 unconfirmed，launch 0 次，没有沿用取消请求的授权。 |
| 校验 await 期间 confirmed:true 手动调用加入 | 两个调用均成功，共用一次 launch。 |
| 校验 await 期间 cancelManual，随后返回 false | stopped，admission 1 次、launch 0 次、no-room 事件 0 次；没有耗完 stale 重试后再弹错误确认。 |
| 校验 await 期间出现独占 holder，校验返回 false | 立即 no-room/exclusive，admission 1 次、launch 0 次，没有通过 stale continue 跳过独占阻断。原阶段 10 行为保留。 |
| admissionCurrent 抛出异常 | 目前按 current=true 处理，旧 ok 直接 launch。服务校验自身 currentLaunchKey 的异常同样 return true（admission.ts:63）；这是保护限制。尚未构造真实生产抛错源导致另一份合法配置被放行，**待确认，不另报一个已复现 major**；建议身份无法证明时不要当成身份已证明。 |

stale 在整个 job 内累计，包括卸载腾空间前后的检查，没有按“连续失败”重置；作为总重试预算可接受，本轮未发现由此绕过资源/确认拦截的证据。已确认启动也不能绕过 stale 次数上限。

**超过次数后拒绝是否合适：** 不再启动、不悄悄卸载其他模型是安全且合理的结果；客户端沿现有路由得到 503 insufficient_memory（流式等待已开始时为 SSE error），手动事件由启动反馈打开 unknown guard，pending 会清除。实际原因是配置不断变化，unknown 文案却声称“读不到可用内存”，确认按钮也不能消除配置持续变动。建议以后用配置已变化/请稍后重试的原因与文案；本轮不把这个准确性建议另升为关口阻塞项。真实 HTTP/SSE/浏览器交互未运行。

### 本轮实际验证及限制

| 命令 / 执行方式（工作目录均为修复 worktree） | 结果 |
| --- | --- |
| `bun test tests/core/scheduler.test.ts tests/core/scheduler-multi.test.ts tests/core/model-ops.test.ts tests/service/multi-load.test.ts tests/app/model-start-feedback.test.ts tests/app/memory-checks-composable.test.ts` | **116 pass / 1 fail，exit 1**。失败为 service 中 risky 确认断言 Expected risky / Received undefined，不是新增 CR-022 回归；如实保留此次失败。 |
| `bun test tests/core/scheduler.test.ts tests/core/scheduler-multi.test.ts tests/core/model-ops.test.ts tests/app/model-start-feedback.test.ts tests/app/memory-checks-composable.test.ts` | **105 pass / 0 fail，exit 0**，5 文件、330 断言。 |
| `bun test tests/service/multi-load.test.ts` | 单独执行两次均 **12 pass / 0 fail**；最后一次独立命令 exit 0、37 断言。首次检查时与其他读命令一起执行的终端最终返回 1 来自末尾无匹配的 rg，不是 Bun 测试失败。单开用例仍报 no-port，只验证非资源拒绝，不能视为真实启动成功。 |
| `bun run typecheck` | **未完成，exit 139**。打印 `SecItemCopyMatching failed -50` 后 SIGSEGV；不能引用实现方 exit 0 作为本轮通过结果。 |
| `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p .nuxt/tsconfig.json` | **exit 0**，执行两次均无输出。是对 worktree 已有 Nuxt tsconfig 的直接类型检查通过，不等于 Nuxt typecheck 生命周期已成功执行。 |
| `bun --eval`，转译现有合成 service 夹具初始化，执行真实接线 | 原“挂住探针、保存新 ctx”得到 `reads=2,spawned=0,code=no-room,reason=memory,state=stopped`；后检查/清理等待场景仍复现上述 CR-022。独立夹具设置 setup.tuned=true，以排除自动调参改变默认值的干扰；没有更改仓库测试夹具。 |
| `bun --eval`，实际前端函数体 + Vue/DeviceProbe；独立 Scheduler 时序 | CR-023/024 原触发条件及上述循环/取消/授权/独占场景结果如表。所有脚本正常退出；未落盘成新测试。 |
| `git status --short`、`git diff --check` | 修复 worktree 收尾仍干净、diff check exit 0。追加前验证主仓库报告前 20418 字节 SHA-256 为 `caffa2c73c7709e402bd10b862c20160f86f990b502aebe2d62646249905fb58`，追加后保留此前全文。 |

首次 service risky 失败的原因没有确诊；fixture 未固定 setup.tuned，而 context 的后台首次硬件调参会改 defaults，这条后台路径在父提交已存在。它是本轮待确认的测试稳定性限制，不能把两次单独通过写成首轮组合测试也通过。没有据这一次结果新增产品 finding。

没有复跑全量 bun test：本机已知沙箱端口监听失败，本轮运行聚焦修复的专项和独立复现；实现方自述的 1482 pass/20 skip 不作为本轮证据。没有 build、真实残留清理/Windows/CUDA/WDDM/Metal/GPU 冒烟、真实公网或浏览器验收。所有产生隔离 context 的脚本均 shutdown 并删除构造目录，Vue effectScope 关闭；没有真实 llama-server 子进程或临时服务残留。原报告的硬件限制继续保留。

**第 2 轮最终判定：rework required；CR-022 未关闭，CR-023、CR-024 已关闭。**

## 第 3 轮 · 2026-10-13

**结论：pass（本轮修复审查范围）。CR-022 已关闭；CR-023、CR-024 保持关闭。** 本轮没有确认的新 actionable finding。这个结论不等于阶段 9 的 Windows/CUDA/WDDM/多卡等全部真机验收已完成；前文硬件限制继续保留。

基线为指定修复 worktree 的 `bcb1b4e1904db1751b6ce9442824bfe4f1a17917`，核对其前一提交 `aadc17d2f8c9bde0bf3c0173722e435fb511c584`，以及它们相对 e117677 的差异。实现与测试均从该 worktree 读取和运行，未使用主仓库未提交实现。只在主仓库本报告末尾追加本节，不改前文，不修改实现、测试、计划或交接，不提交或切分支。修复 worktree 开始和结束均干净。

### 各 CR 判定

| 编号 / 原严重程度 | 判定 | 本轮依据 |
| --- | --- | --- |
| CR-022 / major | **已关闭** | 清理等待移到 admission 前；复核成功后绑定 settings/models 引用；最后 await 之后、同步 planLaunch 之前检查该绑定。原探针窗口、清理等待窗口、保存微任务窗口均独立复跑，未经当前资源检查的新参数均没有进入 Runner。 |
| CR-023 / minor | **保持关闭** | 保存 fresh:true 和共享 force→fresh 接线未回退，memory-checks-composable 回归通过。 |
| CR-024 / minor | **保持关闭** | profile/after 匹配仍保留；新 config-changed 通知分支也经过同一匹配检查。原跨方案晚到事件及无 pending 通知回归通过。 |

### CR-022 独立复现与微任务窗口判定

使用实际 context、ModelOps、Scheduler、service 检查、绑定验证和 launcher；GGUF/配置为隔离合成夹具，内存读数注入，Runner 为捕获启动调用的替身。延迟清理只替换 runStartupCleanup 的 Promise，没有替换 admission 或 launch。所有产生 context 的成功脚本均 finally shutdown 并清理夹具，没有真实模型或 GPU 加载。

| 场景 | 实际结果 |
| --- | --- |
| 原探针窗口：ctx=1024，挂住内存读数，保存 ctx=67108864，再放行 | 内存读取 2 次，返回 no-room/memory，Runner 调用 0 次，状态 stopped。 |
| 第 2 轮清理窗口：真实清理 Promise 尚未解决，发起启动，期间保存大 ctx，再放行 | 放行清理前 `reads=0,state=stopped`；放行后只检查新配置，返回 no-room/memory，Runner 调用 0 次，最终 stopped。没有再先检查旧配置、随后长等清理。 |
| 剩余微任务窗口：清理已 settled；身份复核通过并进入 loading 后，排入一个保存大 ctx 的 queueMicrotask | launcher 的 await 仍会让出一个微任务机会，**这个窗口仍可达，但已被保护**。同步绑定检查拒绝，返回 SchedulerError failed，其 cause.code 为 config-changed；事件为 loading→stopped/config-changed，Runner 调用 0 次。 |
| 上述微任务拒绝后，保存回正常 ctx，再用普通请求 acquire（没有手动 retry） | 正常加载到 ready，Runner 共调用 1 次。前一次没有留下 failed 状态锁住目标，也没有自动立即重试未经检查的配置。 |

关键接线：`server/service/admission.ts:43` 等待真实清理；`:68`～`:69` 验证 key 和配置引用并记入 WeakMap；`:80`～`:84` 同步验证绑定；`server/service/context.ts:427`～`:431` 在最后 await 后先验证，再同步读取相同缓存配置生成 plan。JsonStore.update 替换文档对象，get 返回缓存对象；这几步之间没有 await，因此应用内另一个保存不能穿过同步检查后再改变 plan 的配置来源。之后的异步探测使用已经建立的 plan，不重新读取模型配置。

**isPrecondition 的后果经复核符合本次修复目的：** config-changed 在创建任何进程之前抛出，Scheduler 走 stopped 并删除实例标记的前置条件路径（context.ts:425；scheduler.ts:638），同时拒绝当前 waiters、保留带 config-changed 的 state 事件。下一次调用重新经过资源检查，可以自动尝试；本次调用本身不会被无限自动重试。单开没有 admission 时不增加这道资源保护，沿用既有规则。

验证范围仍是应用配置保存竞态；没有声称能防止任意外部进程在文件读取/加载时原地替换二进制或 GGUF，也没有重做第一轮所有实测失效/硬件待确认项。

### 第 2 轮建议的处理与用户可见结果

- **校验异常不再放行：已处理。** scheduler.ts:596 将 admissionCurrent 异常视为 false；admission.ts:67 将 currentLaunchKey 异常视为 false。独立注入校验异常，手动（含 confirmed:true）与请求均检查 4 次后 no-room/config-changed，launch 0 次。实际 service 的每次 key 复算抛错也经独立脚本复核：8 次 preview/deviceInfo 调用（4 次检查 + 4 次复算），Runner 0 次，返回 503 insufficient_memory。
- **过期次数上限和提示：已处理。** scheduler.ts:601 用 config-changed 区分配置过期/无法证明身份与资源读数 unknown；两种情况仍都拒绝启动。确认标记不能突破此上限。现有取消、共享等待者、独占 holder 回归通过，没有确认到这些逻辑被两次提交回退。
- **手动启动：已验证实际前端函数体。** no-room/config-changed 与 loading→stopped/error=config-changed 两条路径均清除 pending，显示 kind=config-changed 通知，guard 数为 0；不再要求用户确认内存未知风险。loadError 和 failure.advice 的中英键均存在，实际 modal 的既有 view 映射会读到它们。
- **请求错误码需要区分，不能笼统转述为全部 insufficient_memory。** 直接调用真实 proxy.handleV1（标准 Request/Response，无监听端口）证明：重试超限/校验持续抛错走 no-room，为 **503 insufficient_memory**；最终同步绑定失败走 LaunchConfigError→SchedulerError failed，为 **503 model_load_failed**，响应说明配置在内存检查期间被修改。两条都不启动，并允许后续请求重新尝试。本轮未把加载前的前置条件错误与 no-room 强行归为同一个码；该区别沿用已有 proxy 的错误分类。流式等待已发送 200 SSE 的路径仍通过 error 事件收尾，真实流/公网隧道未测。
- **i18n parity：通过。** 英文覆盖 1844/1844 中文键；新 events.noRoomReason、api.noRoom、loadError、failure.advice 的 config-changed 中英文内容/占位符一致，诊断与 live.errorText 会返回该稳定 kind。没有评价主仓库其他翻译改动。

普通显式 start/retry 有 pending，前置条件错误能显示上述通知；内部切方案/保存后重启没有 pending 时，state 错误沿用原消费者语义，仅在事件中显示，不因此自动弹框。no-room 的无 pending 通知仍保留。本轮没有扩展修改内部管理动作的整体反馈契约。

### risky 偶发断言的诊断

**实现侧解释的机制已独立复现；不能证明上一轮那一次历史运行的唯一原因。** 不是只依据代码推断：本轮在内存中把合成 service 夹具改为 tuned:false，并控制真实 detectSystem 的完成时刻（仍执行真实探测及真实 tunedDefaults/background 更新）。先按旧预估构造 95% 的 risky 预算，再允许后台首次调优完成：

```json
{"initialCtx":262144,"initialNeed":1084.1898826293946,"oldRatio":0.9518787380416107,"afterCtx":32768,"afterNeed":164.30588262939455,"afterTier":"ok","tuned":true,"settingsChanged":true,"result":{"accepted":true}}
```

这就复现了“按旧需求应为 risky，但 precheckStart 没有 reason=risky”的失败机制。tuned:true 的同条件对照则 `afterCtx=262144,settingsChanged=false,afterTier=risky`，precheckStart 拒绝 reason=risky。context.ts:653～`:660` 的这条首次调优路径在父提交已存在；把该专项夹具明确固定 tuned:true 是隔离测试配置的合理处理，没有删除 Windows mlock 继承/风险确认断言。本轮 155 项组合专项执行两次均通过，但不把有限次数通过称为无限稳定性证明。

### 实际验证、失败记录与收尾

| 命令 / 方式（修复 worktree） | 实际结果 |
| --- | --- |
| `bun test tests/core/scheduler.test.ts tests/core/scheduler-multi.test.ts tests/core/model-ops.test.ts tests/service/multi-load.test.ts tests/app/model-start-feedback.test.ts tests/app/memory-checks-composable.test.ts tests/core/errors.test.ts tests/core/i18n-parity.test.ts` | 执行两次，均 **155 pass / 0 fail，exit 0**，8 文件、2292 断言，parity complete。service 单开用例仍因沙箱 no-port 不能真实启动，只证明非资源拒绝。 |
| `bun run typecheck` | **未完成，exit 139**：SecItemCopyMatching failed -50 后 SIGSEGV。没有采用编排方的 exit 0 替代本轮结果。 |
| `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p .nuxt/tsconfig.json` | exit 0。 |
| 相同直接 vue-tsc 命令，分别使用 `.nuxt/tsconfig.app.json`、`.nuxt/tsconfig.server.json` | 两个均 exit 0，分别验证 worktree 已生成配置下的前端/服务端类型；不声称 Nuxt typecheck 生命周期已成功执行。 |
| `bun --eval`：真实 service 的探针/清理/微任务竞态、实际 proxy、前端函数体及 Scheduler 异常路径 | 正常退出，结果如上；未生成新测试文件，没有 HTTP 监听器或真实模型进程。 |
| `bun --eval`：控制真实 detectSystem 完成时刻，tuned:false / true 对照 | 更正脚本后两组正常退出，复现诊断机制与夹具隔离效果。 |
| `git status --short`、`git diff --check` | worktree 仍干净，diff check exit 0。追加前原报告 31335 字节 SHA-256 为 `98d8fb356896ddd5ab470eaf801386330c765d68006057b0be0b11cd773e1fc1`，追加后保留此前所有字节。 |

调试失败如实记录：首次读取上一轮内存脚本缓存不存在，未执行复现；最初两组调优脚本因 mock 的模块命名空间引用再次指向 mock 自身而没有完成，已通过运行会话 Ctrl-C 停止（exit 130），不计为验证通过。尝试 ps 查看任务进程被沙箱拒绝；随后用会话控制停止，确认合成锁记录中的进程已退出、夹具内容属于本次构造后删除两处残留。改为在 mock 前保存原 detectSystem 函数后重跑成功。收尾没有剩余合成 fixture 锁、临时脚本、context 或测试服务。

没有复跑全量 bun test，编排侧的 1488 pass/20 skip 不是本轮证据；未运行 build、真实残留/Windows/CUDA/WDDM/多卡/真实模型加载、浏览器及公网端到端。按已运行的软件专项、独立原触发条件和实际调用链核对，本轮没有尚未关闭的 actionable finding。

**第 3 轮最终判定：pass；CR-022 已关闭，CR-023、CR-024 保持关闭。**

## 处理结果汇总（2026-10-13）

- r2 的 CR-010 至 CR-021：本轮判定在 HEAD 上均已解决（CR-020 同身份原地替换的支持边界仍待确认）。
- 新发现 CR-022、CR-023、CR-024：全部**已修复**，第 3 轮整体结论 pass。另外 service 夹具固定了 `setup.tuned: true`，排除首次调优在后台改写参数导致的 risky 断言偶发失败。
- 仍未覆盖：Windows / CUDA / WDDM / 多卡真机、真实 OOM、row / tensor 逐卡建模（见上文「r2 待确认项与阶段验收限制」）。这些属于计划里的硬件任务，不在本轮软件审查范围内。
