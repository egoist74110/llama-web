# 阶段 2 Codex 第五轮复审

- 日期：2026-10-01。
- 提交：`c93c4e678558339b7a0042890b2c2471a802418c`；范围：`cd6ff05..c93c4e6`。以下实现、测试、计划行号对应该提交。
- 总体结论：**rework required（需要继续修正）**。CR-009、CR-010 原触发场景已关闭；新增 CR-011（中）：已在目标方案加载时，补回目标的判断遗漏其他模型的排队请求。
- 已读取 AGENTS.md、计划核心行为规则 / 阶段 2 验收标准 / 最新变更记录、最新交接、第四轮报告及两条处理说明；沿用本会话已加载的 code-review、只读复审和资源清理规则。
- 起点 `cd6ff05` 工作区干净，先获取远端再快进到指定提交。只新增本报告，不修改现有代码、测试或文档，不提交、不推送。

## CR-009 · 已关闭 · 中 · 加载中保存后会真正重载配置

**证据：** `server/core/model-ops.ts:119-123` 保存后调用 reload=true 的 restart；`:65-68` 保留客户端，另在队尾创建管理任务。`server/core/scheduler.ts:235-242` 的 last / reload 不经 jobFor 合并；`:434-437` 发现旧实例后 drain / evict，再重新 launch。配置读取仍在 `server/service/context.ts:145-150`。

本轮将 `tests/core/model-ops.test.ts:298-316` 新增测试的原测试体及断言，在内存分别绑定 `cd6ff05` 和当前真实 Scheduler / ModelOps：

```text
cd6ff05：fail，timed out waiting for condition（没有第二次 launch）
c93c4e6：pass
```

当前断言覆盖：客户端拿到原进程租约；释放后第二次启动读取 8192；两次捕获配置为 [4096,8192]；旧进程停止；管理 work 等新进程 ready 才完成。旧版失败不是缺少新 API，而是第二次启动没有发生。该复现直接验证原失效窗口，因此本条关闭。

`:318-326` 的“ready 且无排队时保存重启”测试在旧、新实现都通过，是回归保护，不能算本次修复的红灯。修复方另有构建产物真实接口及假进程参数记录，本轮没有重跑 HTTP 或实际 argv 回读，不把其结果当作本轮实测。

## CR-010 · 已关闭 · 中 · 较早同目标客户端任务不再吞掉管理队尾目标

**证据：** `scheduler.ts:240` 的 last 创建独立 newJob，`:404-405` 在队尾入队；`model-ops.ts:68,109,111` 使用 last。新的 `:105-109` 补上“已在目标方案，但其他方案请求仍排队”的处理。

本轮以内存原测试体验证 `tests/core/model-ops.test.ts:328-345`：

```text
cd6ff05：fail，实际启动 [H,B,C]，缺少末尾 B
c93c4e6：pass，启动 [H,B,C,B]，最终 B ready
```

两个客户端仍各取得请求目标，没有恢复取消客户端的旧行为。原同一模型 B→C 排队后切 B 的问题解决，本条关闭。

另外，本轮单独覆盖了新 settled 分支：m:B loading、同一模型 C 排队，此时 switchTo(m,B)。旧版无 work、启动 [B,C]、最终 C；当前有 work、启动 [B,C,B]、最终 B。该探测证明新判断确有作用，不将名称近似的其他测试误当作该分支覆盖。跨模型对应场景见 CR-011。

**其余新增测试的区分能力：** `:347-365` 的切 C 再回 B，以及 `:367-395` 的更晚切换 / 显式停止，在旧、新实现均通过。该 describe 实际新增 **5 条测试**，内存对照为旧 2 fail / 3 pass，新 5 pass；与最新交接“新增 6 条、旧 3 条失败”的计数不一致，本报告采用实际 diff 和本轮执行结果，不把统计差异单独列为代码缺陷。

## CR-011 · 中 · 补回目标的队列判断只看同一模型，遗漏其他模型

**位置：** `server/core/model-ops.ts:105-109`，尤其 `:106` 的 `q.modelId === modelId` 过滤。

**问题描述：** 新的 queuedOther 判断只识别该模型的其他方案。调度器在线上限为 1，另一个模型的排队加载同样会卸载当前目标；但这种任务不满足 queuedOther，settled 分支直接返回 work=null，不为最新方案选择保留队尾目标。于是最新计划 `docs/plan.html:549` 所述“管理目标总是排在已排队客户端请求之后”的行为，只在同模型其他方案时完整实现。

**触发场景：** m 的配置当前方案原为 A；客户端显式请求 m:B，B 已进入 loading；另一个客户端请求 other:X 排在后面。用户在界面把 m 的当前方案由 A 切到 B。因为 B 还在加载，当前实例被认为已满足目标；X 不被 queuedOther 识别。两个客户端完成后，最终只有 other:X，m:B 没有按新的管理意图在队尾恢复。

本轮用真实 Scheduler / ModelOps、可控 ready 的假进程复现，实际输出：

```text
切换前 models=[m:B loading]
queue=[m:B(started=true,waiting=1), other:X(started=false,waiting=1)]
switchTo(m,B)：restarted=false，hasWork=false
启动顺序：[m:B,other:X]
最终 models=[other:X ready]，queue=[]
```

该复现调用管理核心方法，没有启动 HTTP；配置由 A 切 B 的接口接线仍是 `server/api/models/[id]/profile.post.ts:13-19`：仅在当前配置已经是 B 时才提前返回，否则更新配置并调用 switchTo，所以显式 m:B 正在加载、配置当前仍为 A 是可到达的场景。

这不是要求管理目标抵挡以后新到达的客户端请求；other:X 已经在管理操作之前排队，按本轮规则应先服务它，再完成管理 B。已有核心路由共享加载规则也不阻止另建管理队尾目标。本问题是本轮新增队列判断的范围遗漏；不声称所有跨模型自动切换都构成缺陷。

**建议修改：** 判定“之后还有任务会使目标不再在线”时检查整个调度队列中的不同目标，包含其他模型，而不是仅检查该模型的其他方案；保留 last 独立任务和后续取消语义。补“m:B loading，other:X 已排队，配置 A→B”的测试，断言两个客户端成功、顺序 B→X→B、最终 m:B ready，并验证后来显式停止或更新的管理操作仍能撤回该尾部目标。

## last / reload、born、取消与崩溃核查

- **born 与 useSeq：** `scheduler.ts:489` 创建实例时记录固定 born；touch 更新 useSeq / 全局 seq，不更新 born。reloadAfter 在管理 start 时捕获 seq（`:241`），因此后续租约取得 / 释放不会把旧实例伪装成新实例。原 CR-009 测试包含该交错且成功重载。
- **后来创建的实例不重复重载：** 本轮构造 H 持租约、A 客户端排队，先 enqueue last+reload A，再释放 H。A 实例在 cutoff 之后创建，当前实际只启动 [H,A]，管理任务复用该 ready 实例，没有第二次 A。按生产配置读取时序，该类实例会读到保存后配置；这条额外探测只记录启动次数，没有回读参数。管理 promise 刚返回时 snapshot 仍可能短暂列出已结算 current（waiting=0），随后 pump 清除；没有据此把微任务窗口当作持久泄漏。
- **序号可靠性的范围：** 当前 launcher 在创建实例后才读取配置，保存接口在发起 restart 前更新配置；在这一调用顺序下 born 可以作为保守的先后判断。它不是配置版本：实例创建早但参数在保存后才读取时，可能多重载一次；reload cutoff 又是在 await stop 后的 start 才捕获，也可能把已经用新参数启动的实例判为旧。这是保守成本，未发现它导致本轮确定的旧参数残留。没有把 Number 精度理论边界列为现实缺陷。
- **显式停止 / shutdown：** 本轮在 A ready 且有租约时执行 last+reload A，等它进入 reload drain，再分别 force stop 或 shutdown。结果分别为管理 promise=stopped / shutdown；均只启动 A 一次、原进程停止，最终实例和队列为空，没有取消后再次启动。
- **cancelManual / 更新管理操作：** last / reload 任务仍使用 manual waiter，新任务没有独立绕过原取消逻辑。`:367-395` 当前测试验证更新切换不启动 B、显式停止不启动 F且拒绝客户端；全量既有 loading stop、pending restart、cancelManual 共享任务检查也通过。客户端加入任务后只撤回 manual waiter的保留规则不变。
- **崩溃自动重载：** 本轮人工让 A 崩溃，经 last+reload 手动重新启动，再崩溃、下一客户端自动重载、再次崩溃。实际状态依次为手动实例崩溃后 crashed、自动实例再崩溃后 failed，启动 [A,A,A]；未见手动重载丢失“一次”限制。全量原自动重载测试也通过。
- **重复加载 / 饿死：** 原 B→C→管理 B 多加载最后 B 是计划明确的成本，保存重载旧 A 也是必要行为；cutoff 后新 A 的探测未多加载。newJob 在队尾固定插入，后来新建任务不能把它反复后移；同目标客户端可能共享较早任务，ready 目标仍直接取租约，进入 draining 后不再直接接新租约，drain 超时负责兜底。未发现本轮确定的无限后移 / 饿死路径，但没有执行持续流量压力或 GPU 加载延迟验证。
- **未解决的阶段验收：** 下拉空值选项任务仍未完成；这不是本次修复新增问题，不重新编号。本轮不等同于阶段 2 全面验收，也不建议据此越过阶段关口。

## 实际命令与验证限制

环境：macOS arm64，Bun 1.3.11。没有读取 secrets、启动真实模型 / HTTP 服务、占用 GPU。内存复验用 Bun.Transpiler / Function 绑定 git show 的旧源码和当前源码，不改测试文件、不写临时代码。测试假进程最终通过 Scheduler.shutdown 清理。

| 实际运行 | 结果 |
| --- | --- |
| `git status --short`、`git log -3 --oneline`、首次 `git show --stat c93c4e6` | 起点干净；本地最初缺提交，git show 退出 128 |
| `git fetch origin`、`git merge --ff-only c93c4e6`、`git show -s --format='%H%n%s' c93c4e6` | 获取并快进到指定提交，确认完整 SHA |
| `git diff cd6ff05..c93c4e6 -- server tests`、文档 diff，cat / sed / rg / nl 读取规则、实现、测试、报告处理说明 | 6 个变更文件，183 insertions / 16 deletions；核对上述行号 |
| `bun test` | **267 pass / 14 skip / 0 fail**；281 tests、23 files、1920 expect calls；退出 0 |
| `bun run typecheck` | 退出 0，通过 |
| `bun -e` 五条新增管理任务测试原测试体，分别绑定旧 / 新核心源码 | 旧 2 fail / 3 pass，新 5 pass；旧失败为预期行为红灯 |
| `bun -e` B loading + 同模型 C 排队的 settled 分支旧 / 新对照 | 旧最终 C，无 work；新最终 B，有 work，顺序 B→C→B |
| `bun -e` B loading + 其他模型 X 排队 | 无管理 work，最终 other:X，复现 CR-011 |
| `bun -e` born cutoff 后创建 A、reload drain 中 stop / shutdown、手动重载后崩溃额度 | 输出如上，无额外 A 重载；停止 / shutdown 清空；自动实例再崩溃为 failed |
| `git diff --check`、`git status --short`、报告空白检查 | 写前无修改；写后只有本报告新增，无空白错误 |

首次内存 harness 的 JavaScript 少了闭合括号，报 Unexpected end of file、退出 1，未开始测试；修正 harness 后原测试体成功执行，退出 0。没有更改仓库代码来让测试通过。

**未运行：** build、真实 HTTP / 浏览器 / 保存接口 argv 回读、Windows CMD、Windows 进程树 / 残留清理、真实 llama-server / GPU / 酒馆、持续请求压力和加载失败 / 延迟的完整组合压力。14 个 skip 包括 6 条 CMD 及其他 Windows 平台检查。修复方的 build / Windows真实接口报告只作为其处理证据，没有冒充本轮运行结果。

本轮按要求不提交、不推送，不更新计划或交接。后续应补 CR-011 的跨模型尾部恢复，再完成既有下拉问题和阶段 2 验收。
