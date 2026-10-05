# 代码审核 · 2026-10-05 · 第二轮

## 结论与范围

**结论：rework required。** 原 CR-001 至 CR-007 按原触发条件复查，均已修复；修复改动引入的 CR-008 为 major，新增回归测试的 CR-009 为 minor，两项均为 open。本轮只审核、写报告，没有修改实现或测试，没有提交或推送。

- 当前基线：`e6bef61cc96e622bd6eb5e402d84a8a58cec34d7`，开始时工作区干净。
- 修复范围：`afaa5aa..e6bef61`；按 [首轮报告](code-audit-2026-10-05.md) 的原触发条件核对，再审查修复引入的生命周期与测试变化。
- 行为依据仍为 `docs/plan.html` 的核心行为规则和当前交接；本轮不修改行为规则，也不推进阶段关口。
- 本轮没有覆盖首轮列出的其他未审模块，不能作为全仓库审核通过的结论。

## 原问题的复审状态

| 编号 | 状态 | 修复与独立复查证据 |
| --- | --- | --- |
| CR-001 | fixed | 看门狗采样后读取候选，`scheduler.unload(..., { idleOnly: true })` 同步检查租约。真实 Scheduler + Watchdog 的挂起采样复现中，采样期间取得的租约未被中断，模型仍为 ready。 |
| CR-002 | fixed | `worstTier` 保留 unknown 高于 risky 的优先级。未知 CUDA 显存 + risky 系统内存汇总为 unknown；真实调度器在已有模型在线时拒绝加载第二个模型，原因 unknown，第二个模型仍为 stopped。 |
| CR-003 | fixed | 历史实测替换占用后，当前预算 unknown 仍为 unknown，只有确定放不下才变为 nofit。共享设备预算未知、系统预算已知的原输入结果保持 unknown。 |
| CR-004 | fixed | 流解析识别 SSE error，抛出具体原因并保留已收到的正文。原部分正文 + error 复现返回 `memory refused` 和 `partial`；真实代理与真实消费者组合中，HTTP 200 的内存拒绝流也传播了估算值与可用值。 |
| CR-005 | fixed | 看门狗遍历告急池。最危险的 CUDA 池只有忙碌模型，另一个 system 池有仅关联 system 的空闲模型时，实际停止后者，事件记录选择的池为 system。 |
| CR-006 | fixed | `useChat` 对两种存储后端均使用 tombstone 包装。执行真实 composable 逻辑，生成期间删除会话，再等待生成收尾，界面会话数为 0，存储未写回已删除会话；正常完成的对照会话仍能保存回复。 |
| CR-007 | fixed（原触发条件） | 加载后采样纳入调度器等待的 ready，原先下一个模型抢先启动并污染采样的触发条件已消除。新增用例单独运行通过；但采样等待新增了进程退出窗口，见 CR-008。整文件测试还存在 CR-009。 |

原条件独立复现的关键结果：

```json
{
  "CR-001": { "leaseAborted": false, "modelStopped": false, "state": "ready" },
  "CR-002": { "poolTiers": ["unknown", "risky"], "aggregate": "unknown", "refusal": { "code": "no-room", "reason": "unknown" }, "bState": "stopped" },
  "CR-003": { "formulaTier": "unknown", "afterMeasurementTier": "unknown" },
  "CR-004": { "error": "memory refused", "partial": "partial" },
  "CR-005": { "stopped": ["b"], "pool": "system" },
  "CR-006": { "visibleSessionCount": 0, "persistedDeletedSession": false }
}
```

CR-006 复现执行了 `useChat.ts` 的真实函数体，Nuxt 自动导入依赖、请求和持久化后端由夹具提供，Vue 响应式逻辑与 tombstone 包装使用真实实现。它比仅测存储包装覆盖更多收尾接线，但没有覆盖浏览器与 IndexedDB。

## CR-008 · major · 采样期间退出的进程仍被标记为 ready

**状态：open。**

**位置：** `server/service/context.ts:448–471`；关联 `server/core/scheduler.ts:579–600`、`:614–616`。

修复 CR-007 后，调度器等待的是 `gated`：底层 `rp.ready` 完成后，还要等待加载后采样，最多 5 秒。然而 `gated` 没有把这段时间的 `rp.exited` 纳入失败条件。

底层健康检查通过后，若进程在采样结束前退出，调度器此时仍为 loading。退出回调在 `onExit()` 中遇到非 ready 状态直接返回，依赖 `runLoad()` 的 ready 等待处理加载失败。但底层 ready 已经成功，采样结束后 `gated` 仍然成功，`runLoad()` 便把死亡实例标为 ready，并发出租约。

**触发场景：** 首个健康检查成功 → 加载后采样挂起 → 子进程退出 → 采样返回或达到超时。快速崩溃、被外部终止等都可落入这个新增窗口。

**实际影响：** Runner 已经没有该进程，调度器仍显示 ready；当前与后续请求得到死亡进程的旧端口，租约未中断，调度器也不会按 crashed 状态执行自动重载。需要手动停止或重启才能恢复。

**复现：** 使用真实 context、Scheduler、Runner 和实际子进程，子进程运行仓库的假 llama-server；内存探测与采样为可控假数据，没有占用 GPU。操作顺序：

1. 构造临时模型、配置与运行时夹具，启动单个模型；首次占用采样返回 100，加载后采样保持 pending。
2. 等底层健康检查通过且加载后采样开始，此时调度器仍为 loading。
3. 终止本次夹具启动的子进程，等待它的 `exited`，确认 PID 已死亡、Runner 列表为空。
4. 让采样返回 1100，等待 acquire；再请求同一模型。

结果：

```json
{
  "stateAtExit": "loading",
  "pidAlive": false,
  "runnerProcessCount": 0,
  "stateAfterSample": "ready",
  "leaseAborted": false,
  "nextRequestGotSamePort": true
}
```

另用假 ModelProcess 独立验证了相同状态转移。真实子进程复现确认这不是仅由假进程接口产生的现象。

**建议的最小修改方向：** ready 的等待阶段必须覆盖底层进程退出；进程退出应作为加载失败传播，不能被“统计失败不影响加载”的 catch 吞掉。采样失败或超时可以放行仍存活的模型，进程已经退出则不能放行。

**需要的回归验证：** 用真实 Runner + 假服务复现“底层 ready 成功、采样挂起、进程退出”；退出后等待中的 acquire 应失败，模型不能进入 ready，后续请求不能取得死亡端口。分别覆盖采样随后返回与采样超时的收尾，确保退出不会被后续采样结果覆盖。

## CR-009 · minor · 新增采样用例读取前序用例的实测记录

**状态：open。**

**位置：** `tests/service/multi-load-run.test.ts:126–128`；关联同文件 `:33–62`、`:74–98`。

整文件共用 beforeAll 创建的 context、目录与 `vram-stats.json`。前一个用例已经加载过模型并留下实测记录。新增用例却读取文件里的全部 entries，断言所有历史记录恰好为 `[1000, 1000]`，没有隔离或限定本次两次加载的记录。

**触发场景与证据：** 本机运行整个测试文件以及完整测试套件都失败，实际值包含前序用例留下的额外记录：

```text
Expected: [1000, 1000]
Received: [62.6, 1000, 1000]
at tests/service/multi-load-run.test.ts:128:71
```

只运行新增用例则通过。前序加载使用真实采样，夹具也沿用默认未完成调优的设置；因此不应假设历史记录的数目或数值固定。此处已确认的是记录未隔离导致断言失败，没有把具体机器内存值或自动调优时序作为已验证的唯一成因。

**实际影响：** 新增回归测试依赖执行顺序与历史记录，阻塞仓库要求的完整测试关口。单独运行通过不能证明整套测试通过，也不能把本次失败归结为原 CR-007 仍然存在。

**建议的最小修改方向：** 为该用例创建独立的 context 与统计文件，或按当前两次加载的具体 stats key 检查对应记录；同时让启动配置与采样输入确定。不要通过删除断言掩盖未隔离的夹具。

**需要的回归验证：** 整个 `multi-load-run.test.ts` 与完整 `bun test` 均应通过，并继续确认采样 pending 时第二个模型没有启动、两次加载各只记录自己的 1000 MiB。

## 验证记录与限制

以下是本轮实际运行结果，不能沿用实施交接里的全绿结论：

| 命令或复现 | 本轮结果 |
| --- | --- |
| `bun test` | 退出码 1：1320 通过、20 跳过、1 失败；1341 项、95 文件，约 25.50 秒。失败为 CR-009 对应断言。 |
| `bun run typecheck` | 退出码 0，通过。 |
| `bun test tests/service/multi-load-run.test.ts` | 退出码 1：2 通过、1 失败，约 4.12 秒；复现上述额外记录。 |
| `bun test tests/service/multi-load-run.test.ts -t 'the measurement after a load'` | 退出码 0：1 通过、2 被过滤，约 1.83 秒。 |
| `bun --eval` 原条件独立复现 | CR-001 至 CR-006 结果见上表；CR-004 还组合执行真实代理与消费者，CR-006 包含正常保存对照。均正常退出。 |
| `bun --eval` CR-008 两种夹具 | 假 ModelProcess 与真实 Runner 子进程均复现死亡实例进入 ready，均正常退出。 |

新增 CR-005 测试的空闲候选使用 `pools: []`，可被当作任意池候选，且没有断言选中的池，因此该测试本身不足以证明遍历到了第二个告急池。本轮独立复现把空闲模型限定为 `pools: ['system']` 并检查选中 system，确认当前实现正确；建议修复轮顺带加强该断言。

没有运行 `bun run build`，没有真实 GPU、Windows、多卡或浏览器验证。用量持久化、8-7、MTP、回收站、桌面壳、更新发包等未审范围仍未展开。

临时夹具的 context 已 shutdown，临时子进程已退出，环境覆盖已恢复，临时目录已删除；独立复现通过内联脚本执行，没有留下测试脚本或配置。仓库只保留本轮报告与首轮报告的复审链接。按 `docs/claude-guide.html` 的审核规则，本轮不提交。
