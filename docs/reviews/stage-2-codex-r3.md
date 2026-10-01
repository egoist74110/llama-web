# 阶段 2 Codex 第三轮复审

- 日期：2026-10-01。
- 复审提交：`bcec4bb02e24b28398d31954550860d48666ba00`；范围：`d78de1f..bcec4bb`。以下实现和测试行号均对应该提交。
- 总体结论：**rework required（需要继续修正）**。（2026-10-01 处理结果：CR-008 已修复；CR-005 余项已修复，「程序路径同时含空白和成对 %」改为预览警告。见各条「处理」。）CR-001 已关闭；CR-005 部分解决；CR-007 已关闭，撤回上一轮对顶层 CMD 括号参数的缺陷判断。新增 CR-008（中）：本轮声明的客户端队列保留语义没有覆盖同一模型已有实例的分支。
- 已读取 AGENTS.md、docs/claude-guide.html 的会话规则、计划核心行为规则 / 阶段 2 验收标准 / 最新变更记录、最新交接，以及上一轮报告和 CR-001 / CR-004 / CR-005 / CR-007 的处理说明。
- 本轮只新增本报告，没有修改现有代码、测试或文档，没有提交或推送。开始时工作区干净；获取远端后从 `d78de1f` 快进到指定提交再验证。

## CR-001 · 已关闭 · 高 · 排队手动启动能被新的方案选择取代

**证据：** `server/core/model-ops.ts:88-95` 先撤回其他方案的手动调用方，再根据实例 / pending restart / withdrawn 决定是否启动新方案。`server/core/scheduler.ts:280-293` 只移除 manual waiter；无人等待的 current 标记取消，未开始的任务直接移出队列。`:412` 在等待释放容量后再次检查取消标记，旧方案不会启动。

原复审触发场景为：other 持有请求租约；手动启动 m:A 等待 other drain；界面切 m:B；释放 other。当前新增测试 `tests/core/model-ops.test.ts:83-104` 同时验证队列只剩 m:B、inUse 只剩 B、旧手动调用返回 stopped、m:A 从未启动、最终 B ready。

本轮把该测试的原测试体和断言在内存中分别绑定 `d78de1f` 和当前版本的真实 Scheduler / ModelOps 执行，未改测试文件：

```text
d78de1f：fail，restarted 预期 true，实际 false
bcec4bb：pass
```

测试失败后 harness 也执行 shutdown。旧代码失败来自行为断言，不是缺少新 API 的导入错误。上一轮 A→B→A、等待 drain 时停止取消重启等既有测试在全量测试中继续通过。因此本条原问题及第二轮余项关闭。客户端保留策略的另一分支另列 CR-008，不混入本条。

**其他新增测试的区分能力：** 同样以内存方式执行 `tests/core/model-ops.test.ts:107-119` 的“客户端保持原方案”和 `:189-202` 的“保存后排队启动”测试，旧、新实现均通过；它们是正常路径覆盖，不能用作本次修复的红灯证据。“保存后启动”测试没有保存配置或断言实际启动参数，只验证无需立即重启及目标方案不变。实际 launch 在 `server/service/context.ts:145-150` 才读取最新配置，支持该设计，但本轮没有做真实保存接口的参数回读。

`tests/core/scheduler.test.ts:376-394` 的 manual/client 共用任务测试在当前版本通过；旧版没有 cancelManual，不把直接运行这条测试得到的缺方法错误算作行为红灯。

## CR-005 · 部分解决 · 中 · 程序路径引用已修正，仍存在明确的 CMD 边界

**证据：** `server/core/args.ts:335-341` 把程序路径交给 quoteCmdProgram，含空白、元字符或 `; , =` 时使用普通双引号，参数仍由 quoteCmdArg 转义。该路径不再把程序名的分组引号写成 `^"`。

本轮实际执行旧、新 formatter，输出如下；另将 `tests/core/args.test.ts:166-167` 的两条程序路径断言独立执行，旧版两条失败，当前两条通过：

```text
输入：X:\a b&c (x)\llama-server.exe
旧：^"X:\a b^&c ^(x^)\llama-server.exe^"
新："X:\a b&c (x)\llama-server.exe"

输入：X:\semi;co\llama-server.exe
旧：X:\semi;co\llama-server.exe
新："X:\semi;co\llama-server.exe"
```

`tests/platform/cmd-preview.test.ts:51-64` 新增真实 CMD 回读测试，硬链接或复制 Bun 到特殊目录，断言最终 argv，finally 清临时目录，验证方法合理。修复方报告旧版本在空白 + & + 括号以及分隔符程序路径上失败，新版全部通过；**这是修复方的 Windows 执行证据，本轮未独立重跑**。本机为 macOS，该条及其余五条 CMD 测试都跳过。上述字符串断言只能证明生成方式改变，不能替代真正 CMD 的旧 / 新红绿验证。

**剩余边界（Windows 实际回读待确认）：** `server/core/args.ts:329-333` 已明确承认程序路径中的 `%NAME%` 会展开。当前对 `X:\%LLW_PREVIEW_VAR%\llama-server.exe` 实际输出为 `"X:\%LLW_PREVIEW_VAR%\llama-server.exe"`，没有保护成对百分号。若该变量已定义，手动预览命令会选择展开后的路径，与参数数组启动的字面路径不一致，可能找不到程序或启动另一处程序；这是阶段 2“手动执行结果与自动启动一致”的剩余限制。CMD 使用百分号替换变量的机制见 [Microsoft CMD 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd#substituting-environment-variable-values)。这里的结果推断结合了文档、源码和修复方已确认的限制；本轮没有执行 Windows 启动来验证实际报错或执行目标。

新增目录 `p100%` 只有一个百分号，不能覆盖这一场景。建议补“路径含已定义变量名的成对百分号”的真实 CMD 回读，并验证可行的字面路径执行方式；若确实不支持，应在界面明确识别和说明限制，不能只留源码注释后仍无条件声称可等价执行。该边界保留在 CR-005，不重复编号。

`/v:on` 下的 `!`、交互窗口粘贴与 `/d /s /c` 的差异仍未验证，不据此额外登记确定缺陷。自动启动仍用参数数组，本条不是对自动启动 shell 注入的指控。

- **处理（2026-10-01）：已修复余项，剩一种组合改为界面警告。** 在 Windows 真实 cmd.exe 上探测了程序路径里成对 `%` 的三种写法（环境变量已定义）：普通双引号会被展开（「系统找不到指定的路径」）；把引号拆开、在引号外给 `%` 加 `^` 能让 cmd 找到程序，但程序自己解析第 0 个参数时会把路径后半段当成下一个参数，参数整体错位，不可用；不加引号、给全部特殊字符加 `^` 的写法在路径不含空白时全部成功（含 `p%LLW_V%x`、`p;q,r=s%LLW_V%`、`p&q(x)%LLW_V%!y`），含空白时失败（cmd 在空格处切断程序名）。因此 `quoteCmdProgram` 改为：不含空白时给 `( ) % ! ^ & | < > ; , =` 加 `^`；含空白时用普通双引号。「含空白 + 成对 `%`」无法安全表达，`previewLaunch` 在这种情况下给出新警告 `preview-program-percent`（界面中文说明：CMD 可能展开，复制的命令可能找不到程序，llama-web 自己启动不受影响），`ok` 不受影响。新增测试：真实 cmd 回读的程序目录加入 `p%LLW_PREVIEW_VAR%x`（变量已定义）、`q&(x)%LLW_PREVIEW_VAR%!y;=`、`a b 100%`，全部通过（前两种用旧的引号写法在探测中失败）；跨平台单测覆盖新格式与 `cmdProgramMayExpand`；launch 测试覆盖警告出现 / 不出现。**仍未覆盖：** `cmd /v:on`；交互式 CMD 窗口里手动粘贴。

## CR-007 · 已关闭 · 中 · 撤回顶层 CMD 括号缺陷判断，保留加固

修复方报告已用真实顶层 `cmd /d /s /c` 执行旧输出，`(abc)`、`)`、`(`、无空白括号路径等 argv 全部保持原样；只有括号块上下文另有问题。预览的目标用法是顶层 CMD，上一轮从文档和字符串输出推断顶层一定有缺陷，证据不足，应撤回该判断。**本轮没有独立复现其 Windows 结论，关闭依据为目标用法、修复方回读证据和当前加固；不是声称自己测过 Windows。**

当前 `server/core/args.ts:325` 已把括号加入检测集合。本轮执行 `tests/core/args.test.ts:161` 的括号输出断言，旧版失败、当前通过；但这证明的是加固格式变化。新增 `tests/platform/cmd-preview.test.ts:46-48` 的顶层回读测试按修复方说明应在旧版也通过，**不能要求它作为原不存在的顶层缺陷的红灯测试**。括号块不是目前的预览契约，本轮没有验证括号块行为。

## CR-008 · 中 · 方案切换仍会取消同一模型的排队客户端请求

**位置：** `server/core/model-ops.ts:88-95`，尤其 `:94` 的 restart 分支；调用链 `:48-55` → `server/core/scheduler.ts:242-249`。本轮新增语义位于 `docs/plan.html:547`；覆盖缺口位于 `tests/core/model-ops.test.ts:107-119`。

**问题描述：** cancelManual 本身确实保留 request waiter，但 switchTo 在该模型还有实例（包括 draining）或 pending restart 时调用 restart；restart 调用按模型清空任务的 stop，后者仍拒绝 queued client waiter 并标记 current cancelled。于是“已排队的客户端请求保持它请求时的方案”仅在该模型没有实例 / pending、等待的是其他模型时成立。当前排队任务尚未进入目标 loading，也会被新的方案选择取消。代理把 stopped 转成 503 model_stopped（`server/core/proxy.ts:109`）。

**触发场景：** m:H ready，已有客户端持有租约；手动启动 m:A，任务等待 m:H drain；一个客户端请求 m:A 加入同一任务；界面切 m:B；释放 m:H 租约。请求 m:A 尚在队列，却返回 stopped，没有加载 A。

本轮用真实 Scheduler / ModelOps、只实现 ModelProcess 的假进程做了两组对照：

| 容量被谁占用 | 切换前 | 切换后队列 / inUse | 最终结果 |
| --- | --- | --- | --- |
| other:H | m:A started=true、waiting=1 | 队列 A、B；inUse A、B | 手动 A=stopped；客户端 A=ready；启动 other:H、m:A、m:B |
| m:H | m:A started=true、waiting=1 | 队列为空；inUse H、B | 手动 A=stopped；客户端 A=stopped；启动 m:H、m:B |

另把第二组绑定旧、新实现，均得到 `manual=stopped, client=stopped, launched=[H,B]`。因此这不是声称 bcec4bb 新引入了该 stop 执行路径，而是**本轮新增的保留契约没有贯穿已有 restart 分支**；新测试仅使用 other，掩盖了该差异。此问题不同于已经关闭的“管理操作被旧手动启动覆盖”。

**建议修改：** 将“内部方案重启”和“用户显式停止”的队列策略分开：切换时撤回旧管理意图，保留客户端目标和等待者，停止旧实例后按约定的 FIFO / 共享加载规则继续处理；显式 stop 仍可拒绝该模型的等待请求。补同一模型 H 正在 drain、客户端 A 和 manual A 共用任务、切 B 的集成测试，断言客户端 A 最终正常完成、旧 manual A 被撤回、新管理目标 B 最终执行；同时覆盖 pending restart 分支。如果产品意图实际上只保留“目标模型完全不在线”的请求，需要先明确并经用户确认这一限制，再同步核心规则与变更说明，不能把当前分支差异当作已经完整实现保留语义。

- **处理（2026-10-01）：已修复。** 核实成立：`restart()` 调用的是按模型清空的 `stop()`，同一模型有实例或待重启时，排队的客户端请求也会被拒绝。`Scheduler.stop` 新增 `keepRequests` 选项：只撤回手动 start/retry 调用方（复用 `cancelManual`），排队的客户端请求连同它们的任务保留原目标和位置；正在为这些请求加载的实例不中止；其余实例照常卸载。`ModelOps.restart`（切换方案、保存后重启）改用 `keepRequests`；显式停止（`ops.stop` / 停止按钮）不变，仍拒绝排队请求。新的目标方案在保留的请求之后入队（FIFO），所以客户端先拿到它请求的方案，结束后再换到新方案。新增测试（修复前前两条失败）：同一模型 H drain 中、手动 A 与客户端 A 共用任务、切 B → 客户端 A 拿到 A 的租约、手动 A 为 stopped、最终 B ready、启动顺序 H→A→B；待重启期间客户端排队 C、再切 D → 客户端 C 正常完成、最终 D ready；显式停止仍拒绝排队请求；Scheduler 层 `keepRequests` 不中止客户端等待中的加载、普通 stop 仍中止。真实接口（构建产物 + 慢响应假 llama-server、临时数据目录、端口 5097，已停已删）复现本条场景：切换返回 `restarted: true`，客户端 `mmm:A` 请求返回 HTTP 200，随后加载 B，最终 `B ready`、当前方案 B，日志启动顺序 默认→A→B，无错误。

## 时序、snapshot 与计划一致性核查

- **已取消 current 与容量等待：** 没有实例的 current 被取消后仍可能等待其他模型 drain 完成；snapshot 隐去的是不会再加载的目标，已有的其他模型 draining 实例仍展示。`:412` 防止释放容量后启动已取消目标。排队旧方案从 inUse 移除符合其不再启动的事实；有 request waiter 的任务由 `:289` 保留，不会仅因 cancelManual 被隐藏。
- **launch 尚未返回时切换：** 本轮额外挂起 m:A 的 launch promise，再切 B。快照 queue 为空，但 models 仍有 A:loading、port=null，inUse=[A,B]，所以已取消任务被隐藏没有把 A 错误释放给改名 / 删除。随后交回假进程，实际结果 manual=stopped、client=stopped，A 的 stop 被调用、最终 B ready。`stop → abortLoad → stopRequested` 会覆盖 await launch 的窗口，未发现该生产调用链遗留 A 的进程。测试里 A.stop 调用两次是原有幂等路径，假进程退出正常；没有据此声称真实 Windows 进程树已经验证。客户端取消边界参见 CR-008。
- **cancelManual 的职责边界：** 它本身不停止已经进入 loading 的进程；生产调用方 switchTo 看到 loading 实例后经 restart 调用 stop。不能把 cancelManual 单独当作进程终止 API。没有发现本轮新增其他生产调用绕开该补偿路径。
- **显式 stop：** `scheduler.ts:244-249` 原本就取消该模型的排队请求；保留这个明确的停止操作语义，与 CR-008 所要求区分的“方案切换”不同。全量测试中的 loading stop、queued stop、shutdown 仍通过。
- **界面与 inUse：** `ModelOps.inUseProfiles:70-75` 汇总实例、未取消任务和 pending；`app/components/ModelEditor.vue:65-72` 随实时状态更新详情并依赖 inUse 禁用操作。当前模型实例的 loading / draining 仍保留保护。未做浏览器交互验证；没有把静态接线检查写成界面验收通过。
- **客户端保留原目标是否冲突核心规则：** 不冲突。`docs/plan.html:264-267` 先解析 model / 当前方案，再排队目标；`server/core/routing.ts:43-48` 在请求解析时选定方案。保持既有客户端目标、后续请求使用新的当前方案，与此顺序及相同目标共享加载相容。问题是 CR-008 的分支实现不一致，而不是要求把旧请求改路由到新方案。
- **CR-004：** 本次没有修改 live.ts 或 SSE 接线；全量测试包括背压 / 有界缓冲 / 取消订阅测试，均通过。认可第二轮报告的边界：超限断开与最近 50 条历史不能保证可靠全量重放。不重复开启 CR-004，也没有做新的网络压力验证。
- **阶段关口：** 下拉空值选项任务仍未完成（plan:424），不属于本次修复回归。不能用本轮核心单测通过替代阶段 2 的真实 UI / 酒馆 / 手动启动验收。

## 实际命令与结果

环境：macOS arm64、Bun 1.3.11。未读取 data/secrets.json，未启动真实 llama-server 或占用 GPU。内存复验通过 `bun -e`、Bun.Transpiler 和 Function 绑定旧 / 新源码，不落临时代码文件；所有假 Scheduler 最终 shutdown，没有真实模型进程、监听端口或未回收测试服务器。

| 实际运行 | 结果 |
| --- | --- |
| `git status --short`、`git log`、`git fetch origin`、`git merge --ff-only origin/main` | 起点 d78de1f 干净；获取并快进到 bcec4bb |
| `git show --format=fuller --stat bcec4bb`、`git diff --stat d78de1f..bcec4bb`、`git diff d78de1f..bcec4bb -- server tests`，及核心四文件 diff | 核对 11 个变更文件、174 insertions / 8 deletions |
| `cat` / `sed` / `rg` / `nl -ba` 读取规则、计划、交接、上一轮报告、实现、调用方和测试 | 建立上述契约、调用链和行号；一次路径探测误用了 server/core/models-api.ts 与 ModelDrawer.vue，不存在而退出 2；随后用 rg --files 找到 server/service/models-api.ts 与 ModelEditor.vue 并读取，未据错误路径下结论 |
| `bun test` | **257 pass / 14 skip / 0 fail**，271 tests、23 files、1882 expect calls；退出 0 |
| `bun run typecheck` | 退出 0，通过 |
| `bun -e` 内存执行三条新增 ModelOps 测试原测试体，分别绑定旧 / 新源码 | 旧 1 fail / 2 pass；新 3 pass。旧失败为预期行为红灯，harness 捕获，当前测试没有失败 |
| `bun -e` 旧 / 新 formatter 输出和三条独立新增格式断言 | 程序元字符路径、分隔符路径、括号输出断言：旧 3 fail / 新 3 pass；只是格式断言，未执行 CMD |
| `bun -e` manual + client 共用 m:A，分别等待 other:H / m:H drain，再切 B | 客户端结果分别 ready / stopped，队列、inUse、启动顺序如 CR-008 表 |
| `bun -e` 同一模型 drain 场景绑定旧 / 新源码 | 两版均取消客户端，确认不是新引入 stop 路径 |
| `bun -e` 挂起 launch promise，切 B 后交回假进程 | A 清理，最终 B ready；取消期间实例及 pending 仍保护 A、B |
| 读取 Microsoft 官方 CMD 文档 | 核对变量替换、引号及延迟扩展说明，未替代 Windows 执行验证 |
| `git diff --check`、`git status --short` | 写报告前无修改和空白问题；写报告后仅新增本报告，另核对报告无尾随空白 |

**没有运行：** build；真实浏览器输入 / 队列显示 / 按钮禁用；真实 HTTP 复现；真实配置保存后的启动参数回读；Windows cmd.exe 旧 / 新回读、交互粘贴、`/v:on`、括号块；真实 Windows 进程树 / 残留清理；真实 llama-server / GPU / 酒馆；网络慢 reader 压力。14 个 skip 包含 6 条 CMD 检查和其余 Windows 专项。修复方已报告的 Windows、构建与接口结果在对应条目中明确归属，没有当作本轮实测。

本轮不提交，不推送，也不更新计划或交接。后续应先处理 CR-008、明确 CR-005 的剩余边界，再完成既有下拉问题和阶段 2 验收。
