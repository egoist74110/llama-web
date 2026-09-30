# 阶段 1 Codex 复审（第四轮）

日期：2026-09-30。总体结论：**通过（pass）**。

**CR-001 剩余部分、CR-013 均已关闭。** 本次修复范围内未确认新的产品代码缺陷，不新增 CR-014。上轮的偶发测试失败本轮再次出现，已缩小到本机 Bun 1.3.11 的 GC 条件，详细记录如下；不能将全部运行描述为通过。后续连续五次全量测试通过。

## 范围与依据

- 已读 `AGENTS.md`、最新交接、上一轮报告中两条“处理”和文末“处理结果”；沿用并核对计划中配置自动重载、终止请求与阶段 1 的验收要求。
- 工作区开始时干净，获取远端后 fast-forward 到 `1349234`；`git log --oneline be29894..1349234` 确认只有一个修复提交，完整 diff 涉及 7 个文件。
- 本报告行号对应 `1349234`。只检查两项剩余修复及其直接影响的转发、store/context、测试；没有重新做 CR-002～012 的完整审查，也没有修改任何代码或旧报告。

## 逐条关闭核对

| 编号 | 结论 | 实现与验证 |
| --- | --- | --- |
| CR-001 剩余部分 | **已关闭** | `server/core/proxy.ts:288` 的 sendFinal 将最后事件的文本读取、write、close 整体放入 bounded，以 gone.signal 和发送期限为界；未送达则 abort writer。acquire 失败、响应头前 fetch 失败、转发中模型中止分别在 `:309`、`:324`、`:363` 使用它。原 req.signal 监听在最后发送处理之后才移除。新增 `tests/core/proxy.test.ts:417` 覆盖响应头前崩溃，并验证超时后读取响应被拒绝。本轮独立真实 HTTP 上游探查也确认响应头前强卸载、acquire 失败、发送途中断开和正常送达均正确结束。 |
| CR-013 | **已关闭** | `server/core/store.ts:138`～`:145` 先更新 current/lastWritten 并 notify，再进行迁移保存或调用方保存；`openStore` 的 watch 回调先更新 value，再记录日志。因此后续保存抛错不会遗漏已经读到的有效手改。新增 `tests/core/store.test.ts:176`、`:194` 覆盖立即上报、保存失败、300 ms 后缓存正确和通知不重复。本轮用真实 getContext、实际 watcher、与上一轮相同的 backups 普通文件/EEXIST 故障验证，getter 立即和 300 ms 后均为手改值 9，磁盘仍为 9，settings 的 reload 通知始终只有一次。 |

## CR-001 独立复现与 sendFinal 回归

使用真实 createProxy/Scheduler 和临时本机 Bun HTTP 上游；上游读完请求体后暂不返回响应头。客户端只读一次 loading 心跳，直到清理完成都不继续读取、不 cancel。注入 finalEventTimeoutMs=80，强卸载使用 drainTimeoutMs=25。用每个请求自己的监听移除计数、activeBoundedWaits 和期限后的响应 read 核对任务和响应，未替换任何全局原型。

| 触发 / 客户端行为 | 从触发到任务清理 | 响应结果 |
| --- | --- | --- |
| 响应头前进程崩溃 / 停止读取 | 约 82 ms | 原 req.signal 监听移除一次，之后 read 拒绝，客户端没有 abort/cancel |
| 响应头前排队切换导致强卸载 / 停止读取 | 约 109 ms，含 drain 等待 | 原监听移除一次，之后 read 拒绝，客户端没有 abort/cancel |
| 响应头前崩溃 / 持续读取 | 约 4 ms | 收到 SSE error 并正常读到结束 |
| 响应头前崩溃 / 最后事件发送期间 signal-only 断开 | 约 7 ms | 发送时原监听仍在；断开后响应中止并移除监听 |
| acquire 加载失败 / 停止读取 | 约 81 ms | 原监听移除一次，之后 read 拒绝 |
| acquire 加载失败 / 持续读取 | 约 4 ms | 收到 SSE error 并正常读到结束 |
| acquire 加载失败 / 最后事件发送期间 signal-only 断开 | 约 7 ms | 发送时原监听仍在；断开后响应中止并移除监听 |

七个场景结束时 inflight=0、activeBoundedWaits=0；未观测到 unhandledRejection。超时场景在确认监听移除和等待者归零之后才再次 read，不把该次 read/cancel 当作促成清理的操作。移除监听的位置现在位于 sendFinal 之后，再结合响应被中止，补足上轮“只看监听移除不足以证明任务结束”的证据。

sendFinal 的内层 Promise 和 writer.abort 均有拒绝处理；bounded 提前结束后仍持有底层 Promise 的失败处理器。新的 listening 标记让取消等待者计数只减少一次，避免 abort/超时与迟到结算重复减数。正常转发成功、上游错误、已有响应头后背压强卸载/崩溃的仓库测试也通过；没有发现本轮改变租约的幂等释放。

初版独立探查把 reader.closed 的提前通知也作为等待条件，出现一次观察超时；调整为与仓库测试一致的“发送期限后验证 read 拒绝”，并让假上游明确读完请求体后持有响应头，再完成上述七项验证。该初版结果不足以证明产品缺陷，没有将它算作通过或新增发现。

## CR-013、迁移、watcher 与日志

真实 context 的复现顺序：初始 sampleSec=7 → 有效手改为 9 → 立即 updateSettings 写 current → refresh 读取成功 → 备份因 EEXIST 失败。getter 立即为 9；300 ms 后仍为 9；同一 settings 编辑的 reload 日志为 1 次，磁盘手改保留。启动附近另有 models 文件的独立 reload，按文件区分后确认不是 settings 重复通知。

另外用自造版本 1/2 的文档检查泛型 store 的迁移边界：

- 手改旧版本后 refresh：回调收到归一化后的版本 2 和正确 prev；迁移成功写入版本 2，备份原文一次；重复 refresh 和随后 watcher 共只上报一次。
- 迁移保存因备份目录异常失败：openStore 立即得到有效的迁移后内容，稍后仍一致；磁盘保留版本 1，错误继续抛出，reload 只有一次。这表示有效内容已重载，不表示失败的迁移已经落盘，未发现数据覆盖。
- watcher 对同一 lastWritten 文本跳过；自己的成功写入仍由 openStore.update 更新缓存，不额外产生手改通知。close 清除回调，未增加遗留 watcher。

没有将通知回调本身当作保存成功；坏 JSON 仍在 notify 之前被拒绝。此前已关闭的导入/手改保存测试也保持通过。

## scheduler 偶发失败：复现及原因范围

本轮在 macOS / Bun 1.3.11 再次看到 `tests/core/scheduler.test.ts:292` 同样的失败：aborted=true，但 reason=undefined，不满足 ModelCrashError 断言。本轮代码已经没有替换全局 AbortSignal.prototype 的测试，故不能把原型替换当作已确认根因。

本轮总共运行 **10 次全量 bun test**。初批五次的完整输出超出工具返回长度，其中首次和另一份可见失败输出均为 **181 pass、7 skip、1 fail、1607 expect**，唯一可见失败都是上述测试；首次约 8.12 秒，该批最后一次为 **182 pass、7 skip、0 fail**。中间逐次摘要被截断，不能可靠还原初批的精确失败比例；因此追加以下五次，完整保留逐次摘要，不编造缺失结果。

| 追加全量次数 | pass / skip / fail | expect | 退出码 | 实际时长 |
| --- | --- | --- | --- | --- |
| 1 | 182 / 7 / 0 | 1609 | 0 | 约 8.05 s |
| 2 | 182 / 7 / 0 | 1609 | 0 | 约 7.93 s |
| 3 | 182 / 7 / 0 | 1609 | 0 | 约 7.87 s |
| 4 | 182 / 7 / 0 | 1609 | 0 | 约 7.92 s |
| 5 | 182 / 7 / 0 | 1609 | 0 | 约 7.94 s |

每次都是 189 tests、17 files；追加五次中的崩溃重载测试均通过。

按 diagnose 方法进一步用进程内替身 ModelProcess 驱动真实 Scheduler，不修改文件、没有全局原型替换，得到较确定的反馈环：

| 改变的条件 | 结果 |
| --- | --- |
| 真实 Scheduler 崩溃后、不强制 GC | 500 次，reason 丢失 0 次 |
| 已观察到 crashed，随后 Bun.gc(true)，再取 lease.signal.reason | 首组 500 次丢失 500 次；另一组 100 次丢失 99 次 |
| 崩溃前用局部变量强引用 lease.signal，再在崩溃后 GC | 100 次，丢失 0 次 |
| 崩溃后先读出并强引用 reason，再 GC | 100 次，丢失 0 次 |
| 把 GC 放在崩溃之前 | 100 次，丢失 0 次 |

失败时 scheduler.snapshot 的 error 仍为 ModelCrashError，源码 `server/core/scheduler.ts:441` 明确调用 controller.abort(new ModelCrashError(exit))。另外剥离 Scheduler，仅用原生 AbortController/Error 的小循环，本机 Bun 在“仅持有 controller、abort 后 GC”条件也出现 reason 丢失；提前持有 signal/reason 的对照不出现。相同原生小循环在 Node v24.13.0、--expose-gc 下四组各 100 次均未丢失。

**诊断结论**：已将该现象缩小到本机 Bun 1.3.11 的 GC 与 signal/reason 对象存活条件，而非本次 sendFinal/store 逻辑或全局原型替换。**Bun 内部实现原因、其他版本及 Windows 是否有同样现象仍待确认**。不能因五次自然运行通过就声称偶发失败已经消失，也不能将本机旧运行时的诊断扩大为确定的 Windows 产品缺陷。

后续环境/测试兼容处理可优先核对实际使用的 Bun 版本；本机实验中，在测试崩溃前保留 `const signal = lease.signal` 并继续做原有 reason 类型断言能够避开该 GC 条件。不要删除或弱化 reason 断言。本轮按用户要求只审查，没有实施这种测试调整或升级运行时。这是已有验证异常的原因调查，不作为本次修复新引入的 CR-014。

## 验证范围与交付

- `bun run typecheck`：两次均通过，退出码 0；第二次在独立探查结束后运行，作为清理后验证。
- `git log` / 完整 `git diff`：确认指定单提交范围；报告写入前 `git diff --check` 通过。
- 7 项平台跳过：Windows 真实残留进程清理、系统 ZIP 解压、Runner 整棵进程树停止，以及 process-tree 的 argv 透传、强杀 Bun 父进程、taskkill /T /F、PID 可执行文件查询。偶发 scheduler 失败不是平台跳过项。
- 没有运行 build、start.bat、Windows/GPU 真机、真实下载、酒馆验收；不将修复方的 Windows 验证记为本轮结果。
- 探查只用临时自造配置、本机替身上游和替身进程；未读取用户真实 data、secrets 或模型。临时服务、流、watcher、目录、环境变量和日志观察均已清理/恢复。

“通过”仅针对本轮两项修复及其代码回归；不表示所有运行环境的测试已稳定通过。阶段 1 的 Windows/GPU 真机与用户试用确认关口仍保留。本轮仅提交并推送本报告。
