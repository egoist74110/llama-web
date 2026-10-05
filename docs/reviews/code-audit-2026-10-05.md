# 代码审核 · 2026-10-05

> 本文保留首轮审核的历史结论与复现证据。修复提交 `e6bef61` 的最新复审见 [第二轮报告](code-audit-2026-10-05-r2.md)：原 7 项的原触发条件已修复，但新增 CR-008、CR-009 仍为 open，整体结论仍为 **rework required**。

## 结论与边界

**结论：rework required。** 本轮确认 7 项：5 major、2 minor；全部为 open，未修改实现、未提交。

- 基线：`afaa5aa3190a45caa46c45449d1fda267afcd22f`，开始时工作区干净。
- 用户要求开始审核，指出很多代码尚未审。本轮优先追踪近期风险最高的阶段 9：`4a828f7..afaa5aa`，包括内存估算、实测优先、加载准入、调度、看门狗、手动启动与界面接线；另审查 `df99bff` 引入的内置对话的流式消费与会话生命周期。
- 读取当前调用链及测试，并检查公网入口、主入口、管理来源校验、Runner 停止流程和更新器删除保护的相关边界。这些边界检查不代表重新完成了其全部历史代码的审核。
- 行为依据：`docs/plan.html` 核心行为规则、决定 41–44、决定 55，以及当前交接。
- 仓库有阶段 1–4、7、8 的审核报告。其中 `stage-8-codex.md` 明确只覆盖 8-1 至 8-3；`first-start-context.md`、`mtp-mode.md`、`model-start-feedback.md` 是独立审查交接，不能视为已通过的审查结论。
- **本轮不是全仓库审核通过。** 用量持久化、8-7 多 GPU 参数与估算语义、MTP / 思考上限、文件回收站、重新推荐参数、桌面 Rust 壳、安装更新与发包链路仍需独立深审；不能用本轮测试结果替代这些模块的审核。

## CR-001 · major · 看门狗会卸载采样期间开始接请求的模型

**位置：** `server/core/watchdog.ts:65`、`:78`；关联 `server/core/scheduler.ts:439`。

`candidates()` 在 `await sample()` 前取得，保存的是当时的 `inflight` 数值。采样期间，ready 模型仍可被 `acquire()` 获取租约。采样返回后看门狗用旧的 `inflight === 0` 选中它，而 `scheduler.unload()` 没有重新检查在途请求，直接进入 draining，超时还会中断请求。

这违反多模型规则第 8 条“有在途请求的模型绝不停”。保护任务会让本来正在正常生成的模型下线；请求超出 drain 时限会被强断。

**复现：** 使用真实 `Scheduler` 和 `Watchdog`，假 `ModelProcess`；先加载并释放租约，挂起看门狗的 sample，在挂起期间重新 acquire 同一模型，然后返回低内存读数。结果：

```json
{"requestAcquiredDuringSample":true,"leaseAborted":true,"modelStopped":true}
```

**建议：** 采样后重新取得候选状态；更关键的是为看门狗提供调度器内同步检查空闲并进入卸载状态的操作，拒绝停止已有租约的实例。补充采样期间进入请求的竞态用例。

## CR-002 · major · risky 覆盖 unknown，未知显存可绕过多开拦截

**位置：** `server/core/memory-estimate.ts:354`；关联 `server/core/scheduler.ts:557`。

`worstTier()` 把 `risky` 排在 `unknown` 之上。CUDA 显存读不到、系统内存算出 risky 时，两个池汇总成 risky。调度只在汇总为 unknown 时执行未知资源拦截，risky 请求会直接加载，甚至在 `onNoRoom: 'error'` 下仍会多开。

这违反多模型规则第 5 条：旁边有在线模型时，读不到可用量应按放不下处理。当前 `tests/core/memory-estimate.test.ts:259` 反而断言这一错误优先级，因此基础测试不会抓住它。`core/admission.ts` 的 decidingPool 已把 unknown 排在 risky 之上，两个口径也不一致。

**复现：** 构造可读架构的模型事实，CUDA0 freeMiB 为 null，系统预算调到 host 占 90%；接入真实 Scheduler，先加载 A，再请求 B：

```json
{"poolTiers":["unknown","risky"],"aggregate":"risky","bLoaded":"ready"}
```

**建议：** 不能由某个已知池的风险档位消除另一池的未知状态；保留 nofit 的明确拒绝，未知优先于 risky / ok。修正相应断言，补充最终调度拒绝用例。

## CR-003 · major · 实测占用会把未知的当前预算改成 ok

**位置：** `server/core/vram-stats.ts:149`；关联 `server/core/memory-estimate.ts:398`、`server/service/model-check.ts:91`。

共享内存设备探测失败、系统内存仍可读时，估算保留已知的系统预算，并把池标为 unknown，因为设备限制还不知道。`preferMeasured()` 随后直接用这个不完整预算重算 `tierOf()`，丢失 unknown，可能返回 ok。

历史实测只说明占用，不能证明现在的设备预算。Mac 曾有同形态的成功加载记录，后来设备列表读取失败时，该路径会让请求在其他模型在线的情况下绕过未知资源拦截，也不会向手动启动显示未知确认。

**复现：** `estimateMemory()` 的共享设备 freeMiB / cap 均未知、系统预算已知，再传入同占用的历史实测：

```json
{"formulaTier":"unknown","afterMeasurementTier":"ok","notes":["layout-unknown","budget-unknown"]}
```

**建议：** 实测替换占用后仍保留当前预算的未知性；最好明确保存预算是否完整，避免仅根据一个部分已知的数值推导档位。补充“有历史记录 + 当前设备探测失败”的测试。

## CR-004 · minor · 对话吞掉 SSE 中的服务端错误

**位置：** `app/utils/chat.ts:210`；关联 `server/core/proxy.ts:374`、`app/composables/useChat.ts:108`。

`streamChat()` 只检查初始 HTTP 状态。`readDelta()` 对 `{"error": ...}` 没有处理，因此 HTTP 200 的 SSE 错误事件被当成空增量。代理在等待加载失败、内存拒绝等情况下，正是通过最后一个 SSE 事件发送错误。对话选择模型时 ready、发送时该实例已被切换或停止的竞态可以进入此路径。

没有正文时界面只显示通用“空回复”；已有部分正文时可能完全不显示失败。调用方无法得知真正的内存拒绝或加载错误。

**复现：** 用 Response 构造 HTTP 200、正文为 `data: {"error":{"message":"memory refused","code":"insufficient_memory"}}` 的流；真实 `streamChat()` 正常返回：

```json
{"streamErrorWasThrown":false,"result":{"stats":null}}
```

**建议：** 识别 SSE error payload 并将其 message 传到 run 的异常路径，保留已有正文并显示具体错误。补充代理流式错误与对话消费者的组合测试。

## CR-005 · major · 最危险池没有空闲模型时，其他告急池完全不处理

**位置：** `server/core/watchdog.ts:75`、`:82`。

看门狗仅选择 `low[0]`。如果它关联的模型都忙，就直接返回；不会查看其他同样低于 5% 的池。

例如 CUDA0 只剩 0.1%、使用它的模型有在途请求，同时系统内存只剩 2%、另有空闲 CPU 模型。当前每轮都选择 CUDA0，报告 blocked，不停止任何模型。系统内存危险线本应允许停止任何空闲模型，却持续得不到保护。

**复现：** 构造以上两个池和两个候选，执行真实 `Watchdog.tick()`：

```json
{"bothPoolsBelowDangerLine":true,"idleModelStopped":[]}
```

**建议：** 按危险程度检查全部告急池，选择第一个仍有可安全卸载候选的池；每轮仍最多停止一个。只有全部告急池都没有可处理候选时才报告 blocked。

## CR-006 · minor · 生成期间删除的会话会被收尾重新写回

**位置：** `app/composables/useChat.ts:116`；关联 `:79`、`app/components/ChatSessions.vue:60`。

删除当前生成中的会话会调用 stop，再从列表和存储删除。但 abort 只发出中止信号，不会等生成任务结束；`run()` 的 finally 无条件 `save(s)`，随后把已删除的会话重新 put。会话列表的删除按钮在 busy 时仍可使用，此路径能由界面直接触发。

当前列表显示已删除，刷新页面后会话又出现，删除的文本与图片继续占用存储。

**复现：** 运行当前 useChat 函数体，用真实 Vue 响应式与 chat helpers、可观测存储桩及响应 abort 的 fetch 桩；发送后立即删除当前会话，等待生成任务收尾：

```json
{"visibleSessionCount":0,"persistedDeletedSession":true}
```

**建议：** 删除前标记会话已删除，使所有晚到的保存拒绝写回；或等待当前任务结束再做最终删除。补充发送 → 删除 → abort 收尾 → 重新读取存储的用例。

## CR-007 · major · 加载后实测采样不在串行加载边界内

**位置：** `server/service/context.ts:434`、`:439`。

加载后采样位于 `void rp.ready.then(async ...)`，而调度器只 await 原始 `rp.ready`。首个模型 ready 后，采样异步等待尚未完成，下一加载任务就可进入 admit / launch。`vramStats.record()` 却硬编码 `exclusive: true`，使下一模型的占用被写进上一模型的实测增量。

这违反实测记录“只记录该次加载增量”的语义。混入额外占用后，后续估算会优先采用错误实测，出现无谓拒绝、卸载和误差告警。采样期间旧实例退出也可能使差值偏低；本轮动态复现的是混入下一次加载的路径。

**复现：** 真实 `getContext()` 接线、隔离配置与构造 GGUF；仅替换 Runner.start 和 usedOf。A 的加载前读数为 100，挂起 A 的加载后读数；此时 B 已启动，B 的读数为 1100 → 2100；最后放行 A 的加载后读数 2100：

```json
{"beforeRelease":{"launches":2,"afterASampleStillPending":true,"completedMeasurements":1},"measurements":[[1000],[2000]]}
```

B 正确记录 1000，A 错误记录 2000，包含两份占用。

**建议：** 将加载后采样完成纳入串行任务边界，同时避免使统计失败变成加载失败；或在有下一次加载 / 卸载并发时弃用该样本。`exclusive` 必须来自实际生命周期证据，不能固定为 true。补充真实 context 接线上的延迟采样测试。

## 实际验证与限制

| 操作 | 结果 |
| --- | --- |
| `git status --short`、`git log -12 --oneline`、相关范围 diff / 源码 / 测试读取 | 确认基线，定位调用链与已有审查范围 |
| `bun test` | exit 0；1311 pass、20 skip、0 fail；1331 项、95 文件，23.75 秒 |
| `bun run typecheck` | exit 0 |
| `bun --eval`，真实 Scheduler / Watchdog / estimateMemory / preferMeasured / streamChat 的内存构造复现 | CR-001 至 CR-005 均复现上述错误结果 |
| `bun --eval`，useChat 生命周期复现 | CR-006 复现；直接导入的首个尝试因 Nuxt `~~/` 别名无法解析失败；最终读取原函数体，经 Bun TypeScript 转译，只替换 import / Nuxt 自动导入的依赖，使用 Vue 和可观测桩运行 |
| `bun --eval`，隔离数据目录下的真实 getContext 接线 | CR-007 复现；未启动真实子进程，Runner 与内存采样为桩；finally 中关闭 context、恢复环境并删除临时目录 |
| `git diff --check`、`git diff --no-index --check /dev/null docs/reviews/code-audit-2026-10-05.md` | exit 0；工作区仅新增本报告 |

没有运行 build、浏览器 / IndexedDB 真机验证、Windows / CUDA、多卡、真实模型或真实内存压力测试。20 项跳过主要涉及 Windows 进程树、CMD、归档与 Windows 服务接线，不能据此认为这些路径通过。

构造复现未写入正式测试目录，未改变生产配置或实现；本轮保留的交付物仅本报告。缺陷尚未修复，现有测试全绿与审核结论不冲突。

建议修复顺序：CR-002 / CR-003（未知资源放行）、CR-001 / CR-005（看门狗）、CR-007（实测污染），再处理对话的 CR-004 / CR-006。修复后按原触发条件闭环复审，保留本报告的编号。
