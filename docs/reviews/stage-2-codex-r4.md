# 阶段 2 Codex 第四轮复审

- 日期：2026-10-01。
- 提交：`67fdf50ce9603769b5e57e17093f63d211149a67`；范围：`066b6db..67fdf50`。以下实现、测试和计划行号对应该提交。
- 总体结论：**rework required（需要继续修正）**。（2026-10-01 处理结果：CR-009、CR-010 已修复，见各条「处理」。）CR-005、CR-008 已关闭；新增 CR-009、CR-010（均为中）。客户端保留的原问题已解决，但同目标任务复用使保存后的重载及部分切换顺序失效。
- 已读取 AGENTS.md、计划核心行为规则 / 阶段 2 验收标准 / 最新变更记录、最新交接、第三轮报告及 CR-005 / CR-008 的处理说明。沿用本会话已读取的 code-review、script-engineering 和只读复审规则。
- 起点 `066b6db` 工作区干净，指定提交本地已存在；快进到 `67fdf50` 后验证。只新增本报告，不修改现有代码、测试或文档，不提交、不推送。

## CR-005 · 已关闭 · 中 · 无空白路径的百分号已转义，剩余组合明确警告

**证据：** `server/core/args.ts:336-344`：无空白的程序路径逐个转义特殊字符（含 `%`）；有空白时用普通引号，检测成对百分号。`server/core/launch.ts:107-112` 仅在 Windows 预览增加 warning，不改变参数校验的 ok 或自动启动。中文文案在 `i18n/zh-CN.ts:245`；`app/components/ProfileForm.vue:151-156,272-274` 把它渲染为警告。

实际在内存中绑定旧、新 args / launch 源码，运行 `tests/core/launch.test.ts:140-146` 新增测试原测试体与断言：

```text
066b6db：fail，预期包含 preview-program-percent，实际 warnings=[]
67fdf50：pass，含警告且 ok=true；普通路径不出现该警告

X:\p%LLW_PREVIEW_VAR%x\llama-server.exe 的 formatter 输出：
旧："X:\p%LLW_PREVIEW_VAR%x\llama-server.exe"
新：X:\p^%LLW_PREVIEW_VAR^%x\llama-server.exe
```

`tests/core/args.test.ts:168-174` 的新格式及检测断言在全量测试中通过。`tests/platform/cmd-preview.test.ts:55-62` 添加了已定义变量的成对百分号、复合元字符、空白 + 单百分号目录，用真正 CMD 启动 argv 夹具回读；finally 清临时目录。修复方报告前两种旧引号写法失败、当前回读成功。**本轮没有 Windows 环境，六条 CMD 测试全部跳过，不能把格式输出改变称作本轮独立取得的真实 CMD 红绿证据。**

闭合的是第三轮提出的“字面转义或明确识别并说明不支持的组合”要求。空白 + `%NAME%` 仍不是保证等价执行的路径；现在按照计划 `:548` 的策略明确警告，因此不再把它作为未披露缺陷保留，也不声称该组合已经安全可执行。复制按钮仍可用，这是本轮声明的 warning 策略；自动启动继续使用参数数组。

**边界检查：** 本轮实际执行 cmdProgramMayExpand / quoteCmdProgram：

| 程序路径特征 | 检测结果 / 输出 |
| --- | --- |
| 无空白的 `%V%` | 无警告；两端 `%` 均加 `^` |
| 空白 + `%V%` | 警告；普通双引号 |
| 空白 + `100%` | 无警告；普通双引号 |
| 空白 + `%%` | 无警告；普通双引号；本轮未执行 CMD 验证该边界 |
| 空白 + `%UNDEFINED%` | 仍警告；检测是“可能展开”，不检查实际环境变量是否存在 |
| 无空白的 `^ ; , =` | caret 加倍，其余特殊字符加 caret |
| 空字符串 | 输出 `""`；生产预览在无版本时使用 llama-server.exe 占位名 |

Windows 条件、单百分号及不带空白路径的过滤没有发现确定的新缺陷。检测未定义变量时保守警告与“可能”文案一致。`/v:on`、交互粘贴、组合目录名中控制字符或其他特殊解析上下文未验证，不能据静态输出保证兼容。此处保持 CR-005 关闭，但保留上述验证限制。

## CR-008 · 已关闭 · 中 · 原排队请求不再因方案切换被取消

**证据：** `server/core/model-ops.ts:56` 内部 restart 使用 keepRequests；显式 stop 的 `:42-44` 不使用它。`server/core/scheduler.ts:248-259` 只撤回 manual waiter，保留客户端任务的位置和目标；`:265-266` 不 abort 当前仍被请求等待的加载；普通 stop 的 `:251-256` 仍取消队列和 current。

本轮把新增测试的原测试体 / 原断言分别绑定 `066b6db` 与当前真实 Scheduler / ModelOps，在内存执行：

| 测试 | 旧代码 | 当前代码 |
| --- | --- | --- |
| `tests/core/model-ops.test.ts:129-149`：H drain，manual A + client A，切 B | fail：stopped: m:A | pass：客户端拿 A，manual stopped，最终 B，H→A→B |
| `:151-168`：待重启 B，client C 排队，再切 D | fail：stopped: m:C | pass：客户端拿 C，最终 D |
| `:170-181`：显式停止仍拒绝请求 | pass | pass |
| `tests/core/scheduler.test.ts:396-417`：keepRequests 保留正在加载的请求，普通 stop 中止 | fail：stopped: a:默认 | pass |

旧代码已经存在 stop 和 cancelManual，失败来自请求被取消的真实行为，不是缺少新函数。显式停止测试是回归保护，本来就应在旧版通过。原 CR-008 的两种触发场景已不再出现，本条关闭；另见 CR-010 对更复杂顺序的缺口。

## CR-009 · 中 · 加载期间“保存并重启”会加入旧加载，实际不应用新配置

**位置：** `server/core/model-ops.ts:56-59`；`server/core/scheduler.ts:265-266,224-229,376-379`。生产入口为 `server/api/models/[id]/profiles.post.ts:47-53`，文件保存也走 `files.post.ts:30`。

**问题描述：** restartIfUp 把 loading 视为需要重启的实例；修改配置后 restart 调用 keepRequests，客户端仍在等待的旧加载被保留。随后 start 同一目标通过 jobFor 直接加入旧 current job，等旧进程 ready 后返回成功，根本没有第二次 launch。配置只在 `server/service/context.ts:145-150` 的新 launch 时读入，已经交给 runner 的启动参数不会因配置保存而改变。接口仍返回 restarted=true，界面提供的“保存并重启”实际退化成等待旧加载完成。

**触发场景：** 客户端触发 m:A，已经用 ctxSize=4096 启动进程、仍在等待健康检查；用户将 A 改成 8192 并选择重启；随后旧进程 ready。模型继续按 4096 运行。更换文件后重启也有同类风险。

本轮用真实 Scheduler / ModelOps 和可控 ready 的假进程，launch 捕获当时的配置值；保存对应更新该值，然后调用 restartIfUp('m','A')。旧 / 新对照的实际结果：

```text
066b6db：launch 配置 [4096,8192]；旧请求 stopped；旧进程停止；新进程 ready
67fdf50：launch 配置 [4096]；客户端 ready；旧进程未停止；restart promise 已完成
```

这不是要求恢复旧版取消客户端的做法；对照只证明本轮丢掉了实际重载。保留客户端和最终应用保存后的参数应同时成立。内存复现验证了加载和重启控制流，没有执行真实保存 HTTP 接口或回读真实进程 argv。

**建议修改：** 为保存后的重载保留独立意图 / 配置版本，不能仅用相同 model+profile 的 start 与旧加载共享完成信号。允许原客户端完成后，再按新配置真正重载，并由新重载完成来结算管理 work；显式停止或新管理操作仍能使该意图失效。补“配置已被 launch 捕获、加载未 ready 时保存并重启”的测试，断言客户端保留、实际再次读取新参数、最终进程使用新配置。当前新增 loading 测试只验证保留加载，没有验证保存参数；既有保存测试使用立即 ready 的假进程，未覆盖这一窗口。

- **处理（2026-10-01）：已修复。** 核实成立：管理启动经 `jobFor` 并入了同目标的旧加载任务。`Scheduler.start` 新增两个选项：`last` 总是在队尾新建任务、不并入更早的任务；`reload` 记下当前序号，任务执行时如果该方案的实例是在这之前创建的（ready / draining），先等它的请求结束并卸载，再重新启动（启动时读取最新配置）。实例新增 `born` 序号。`ModelOps.restartIfUp`（保存后重启）走 `restart(..., reload=true)`。新增测试（修复前失败）：客户端触发的加载已用 4096 启动、尚未就绪时保存为 8192 并重启 → 客户端拿到原加载的租约，结束后再次启动，启动参数依次为 4096、8192，旧进程已停止，管理 work 在新进程就绪后才完成；另有「已就绪方案保存后重启」测试。真实接口（构建产物 + 3 秒才就绪、把启动参数写入文件的假 llama-server，临时数据目录、端口 5097，已停已删）：A 为客户端请求加载中时保存 A 的上下文 8192 并重启 → 返回 `restarted: true`，客户端请求 HTTP 200，随后重新启动；假进程记录的两次启动依次为 `ctx=262144`（全局默认）和 `ctx=8192`。

## CR-010 · 中 · 新管理目标与先前客户端目标相同，会提前合并，最终停在另一方案

**位置：** `server/core/model-ops.ts:58-59`；`server/core/scheduler.ts:224-229,376-379`。违反本轮最新计划 `docs/plan.html:548` 的“新方案排在保留请求之后”。

**问题描述：** restart 等卸载完成后调用 start(profile)，但 start 会复用队列中较早的同目标客户端任务，或者在该目标已经 ready 时直接成功。该调用没有为新管理意图预留队尾位置。若同目标后面还有其他客户端目标，管理 work 会先完成，后续请求继续切换，最终方案与新选择不一致。保留客户端本身正确，错误是把管理启动也合并进它们前面的加载。

**触发场景：** m:H 有在途租约；客户端 B 进入 current 等 H drain，客户端 C 排在 B 后；用户切当前方案为 B；释放 H，两个客户端各完成请求。

本轮真实 Scheduler / ModelOps 内存复现：

```text
释放 H 前：queue=[B(started=true,waiting=1), C(started=false,waiting=1)]
两个客户端取得的目标：[B,C]
launch 顺序：[H,B,C]
管理 work 已完成；最终 models=[C:ready]，queue=[]
```

按最新计划应在保留的 B、C 之后执行新的管理 B，即本场景最终应回到 B；现有测试只有“旧客户端 A、新管理 B”或“旧客户端 C、新管理 D”，目标都不同，因此没有暴露共享加载吞掉管理队尾意图的情况。这条是新增 keepRequests 之后显现的顺序问题，不重开客户端被取消的 CR-008。

**建议修改：** 区分“客户端等待同一次加载”和“在旧请求之后执行最新管理意图”；不要让后者仅因目标相同就由较早客户端任务结算。给管理动作保留可失效的队尾任务 / 屏障，确保原请求 FIFO 完成后执行最新目标；结合 CR-009 避免同方案配置重载也被复用掉。补 B→C 客户端队列后手动切 B 的测试，断言客户请求正常完成、最后 B ready，并覆盖在此期间显式停止及更晚切换取消该管理意图。

- **处理（2026-10-01）：已修复。** 核实成立，与 CR-009 同一根源。方案切换的重启和「撤回手动启动后改启新方案」都改用 `start(..., { last: true })`，新目标排在保留的客户端请求之后，不再由更早的同目标任务结算。另外补了「已经在该方案上运行、但有其他方案的请求排队」的分支：也在队尾补一个回到该方案的任务。新增测试（修复前前者失败）：H 在 drain、客户端 B、C 依次排队、切 B → 两个客户端正常完成，启动顺序 H→B→C→B，最终 B ready；切 C 再切回 B → 启动顺序 B→X→C→B，最终 B；排队中的管理目标会被更晚的切换撤回（只启动 D），也会被显式停止取消（不启动 F，客户端请求被拒绝）。真实接口复现本条场景：默认方案有在途请求、客户端 B、C 依次排队、切 B → B、C 都 HTTP 200，最终 `B ready`、当前方案 B，日志启动顺序 …→B→C→B，无错误。

## 其余时序与规则核查

- **保留加载与普通 stop / shutdown：** 本轮额外构造 A 正在 loading、切 B 已排队，再分别执行 ops.stop(m) 和 scheduler.shutdown。stop 得到 request=stopped、work=stopped；shutdown 得到 request=shutdown、work=shutdown。两组都只 launch A，A 已停止，最终 models / queue 为空，没有启动 B。假进程覆盖 Promise 时序，不等于 Windows 进程树测试。
- **待重启代数：** 新 pending 分支测试通过，旧重启被更新的代数取代，客户端 C 保留。全量已有 A→B→A、停止取消 pending restart 等测试通过。没有发现本轮确定的代数清理泄漏。
- **FIFO 与共享加载：** 客户端原任务不挪位置、普通不同目标的新管理任务排在后面，与核心路由 `plan:264-267` 和本轮变更记录相容；CR-010 指出的是目标相同的合并例外。客户端保持请求时方案本身不与核心规则冲突。
- **snapshot / inUse：** 被保留的请求仍在任务中，当前 loading 仍在实例中，pending 新目标由 ModelOps 保护；没有仅因 keepRequests 把活动目标从 inUse 移除的新路径。未启动浏览器检查显示和按钮禁用。
- **警告与自动启动：** preview warning 只追加到预览 warnings，未进入 planLaunch 的参数构建或阻止自动启动；i18n 渲染路径存在。没有把参数数组启动改成 shell 字符串。
- **范围外验收：** 计划仍有未完成的下拉空值选项任务。本轮不修复或重新编号，也不把测试通过等同阶段 2 真机 / 酒馆 / 界面验收完成。

## 实际命令、结果和未运行验证

环境：macOS arm64、Bun 1.3.11。没有读取真实 secrets、启动 llama-server、占用 GPU 或启动 HTTP 服务。内存脚本通过 Bun.Transpiler 读取 `git show 066b6db:<path>` 和当前源码，不写临时代码文件；假 Scheduler 最终 shutdown。

| 实际运行 | 结果 |
| --- | --- |
| `git status --short`、`git log -4 --oneline`、`git show --stat 67fdf50`、`git merge --ff-only 67fdf50` | 起点干净，指定提交已存在；快进成功 |
| `git diff 066b6db..67fdf50 -- server tests i18n`，及 cat / sed / rg / nl 读取文档与调用链 | 核对 13 个变更文件、161 insertions / 22 deletions |
| `bun test` | **262 pass / 14 skip / 0 fail**；276 tests、23 files、1901 expect calls；退出 0 |
| `bun run typecheck` | 退出 0，通过 |
| `bun -e` 三条新增 ModelOps 测试原测试体，绑定旧 / 新源码 | 旧 2 fail / 1 pass，新 3 pass；旧失败为 stopped: m:A / m:C |
| `bun -e` 新增 Scheduler keepRequests 测试原测试体，绑定旧 / 新源码 | 旧 fail（stopped: a:默认），新 pass |
| `bun -e` 新增 launch 警告测试原测试体，绑定旧 / 新 args 和 launch | 旧 fail（无警告），新 pass；同时打印成对百分号程序路径的旧 / 新 formatter 输出 |
| `bun -e` 加载时修改 launch 捕获配置并 restartIfUp，旧 / 新对照 | 旧 [4096,8192]，新只有 [4096]，详见 CR-009 |
| `bun -e` 客户端 B、C 排队后切管理 B | 客户端都完成；launch H→B→C；最终 C ready，详见 CR-010 |
| `bun -e` 保留加载后显式 stop / shutdown | A 被停止，B 未启动，队列和实例清空 |
| `bun -e` quoteCmdProgram / cmdProgramMayExpand 边界输出 | 结果见 CR-005 表；没有执行 CMD |
| `git diff --check`、`git status --short`、报告空白检查 | 写报告前无修改；写后仅新增本报告，无空白错误 |

**执行中的失败也列明：** 首次 ModelOps 旧代码测试虽然输出预期失败，但清理时未等待的管理 work 产生 shutdown rejection，harness 退出 1；随后对原返回 Promise 附加旁路 catch，不改变返回值或断言，重跑退出 0，得到上表结果。首次 Scheduler 内存 harness 没有完整去掉多行 import，发生 Parser error，退出 1；改为完整移除导入后成功。若干猜测文件路径（ParamForm.vue、ProfileEditor.vue、profiles/[name].put.ts）不存在，读取退出 2；通过 rg 确认实际 ProfileForm.vue、profiles.post.ts 后读取。上述失败不是当前仓库的 bun test 失败；没有隐藏或把它们当作验证成功。

**未运行：** build；真实浏览器警告 / 复制 / 保存并重启操作；真实 HTTP 场景与保存配置后的实际 argv 回读；Windows CMD 旧 / 新执行、交互式粘贴、`/v:on`、括号块；Windows 进程树 / 残留清理；真实 llama-server / GPU / 酒馆；网络慢连接压力。14 条 skip 包含 6 条 CMD 测试及其他平台专项。修复方报告的 Windows CMD、构建、真实接口结果只作为其处理证据，没有冒充本轮实测。

后续应修复 CR-009、CR-010，再完成既有下拉问题和阶段 2 验收。本轮按要求不提交、不推送、不更新计划或交接。
