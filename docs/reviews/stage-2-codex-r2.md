# 阶段 2 Codex 第二轮复审

- 日期：2026-09-30。
- 复审提交：`de19233882c8dca4fe7be7ba42c2dff619834fd6`；范围：`48980ee..de19233`。
- 结论：**rework required（需要继续修正）**。（2026-09-30 处理结果：CR-001 余项、CR-005 余项已修复；CR-007 在 Windows 实测不构成错误，已按建议加固。见各条「处理」。）CR-001、CR-005 部分解决；CR-002、CR-003、CR-004、CR-006 已关闭。新增 CR-007（中，Windows 执行结果待确认）。
- 已读取 AGENTS.md、计划核心行为规则及阶段 2 验收标准、最新交接、上一轮报告每条处理说明，查看了修复提交和差异。行号对应 `de19233`。
- 只新增本报告；没有修改实现、测试、计划、交接或上一轮报告。原工作区干净，本地从 `48980ee` 快进到指定修复提交后验证。

## CR-001 · 部分解决 · 高 · 原始 draining 场景修复，但仅排队的管理启动没有被后续切换取代

**已解决部分与证据：** `server/core/model-ops.ts:48-57` 在等待 stop 后核对代数，较新的操作会使旧重启失效；`:84-90` 不再把 draining 当作已稳定服务的状态。启动、重试、停止、切换和保存后重启的接口已接到 `ctx.ops`。

本次用实际 `profile.post.ts` 处理函数、内存 AppContext、真实 Scheduler 和假 ModelProcess 对照原始场景：A 有在途请求，切 B，再于 drain 中切 A，最后释放请求。

```text
48980ee：active=A，B:ready，启动记录=[m:A,m:B]
de19233：active=A，A:ready，启动记录=[m:A,m:A]
```

`tests/core/model-ops.test.ts:40-56` 的断言能识别旧行为；`:60-70` 的 drain 期间停止、`:129` 开始的保存后重启测试均通过。本次没有将新测试文件直接放进旧 checkout 执行：旧提交没有 ModelOps，直接复制会因模块不存在而失败，不能当作有意义的红灯。采用旧处理函数与新处理函数的真实行为对照，确认原场景的最终状态断言旧失败、新通过。

**未解决部分、位置：** `server/core/model-ops.ts:84-91`（另见 `:32-34`）；`server/api/models/[id]/profile.post.ts:15-17`。

**触发场景：** other 模型正在处理请求；用户启动 m:A，m 的任务进入 Scheduler 当前队列、正在等 other drain，m 尚无 Instance。此时用户把 m 当前方案改为 B。switchTo 只看 instances 和 pending restart，没有看队列；`mine.length === 0` 时直接返回 null，既没有 bump，也没有取代旧手动启动。释放 other 请求后，m:A 仍启动，配置却是 B。本次实际处理函数复现结果：

```text
切换前：other:A:draining；queue=[m:A, started=true, waiting=0]
切换响应：{ ok:true, restarted:false }
最终：activeProfile=B；m:A:ready；启动记录=[other:A,m:A]
```

这里排队的是 `ops.start()` 的管理启动，复现不依赖应继续保留的显式客户端 A 请求。新增的代数只保护已经登记到 pending 的重启，不能覆盖这个启动意图；“最新管理操作生效”及“切换方案后实际运行一致”的目标仍未完整达到。

**建议修改：** switchTo 应识别本模型已排队的管理启动，并使旧管理意图失效、按新方案重新排队；明确区分管理启动与正常客户端请求，保留计划要求的客户端 FIFO/共享加载语义。补充“其他模型 drain 中，m 手动启动 A 排队，再切 B”的处理函数集成测试，同时检查 start/retry 已排队后切换及保存后重启。不要仅验证已有实例的 A→B→A。

- **处理（2026-09-30）：已修复。** 核实成立（`switchTo` 没看队列）。Scheduler 新增 `cancelManual(modelId, which)`：只撤回该模型排队中 / 正在执行（尚未启动进程）的加载任务里的手动 start/retry 调用方（以 `stopped` 拒绝），客户端请求照常排队；任务没人等了就丢弃（正在执行的标记 cancelled，在启动进程前退出）。`switchTo` 先撤回其他方案的手动启动，撤回了就按新方案 `ops.start()`（`restarted: true`）；已有实例或待重启时仍走原来的重启路径。另外 `snapshot().queue` 不再列出已取消的任务，所以被撤回的启动在收尾期间不会显示为排队，也不会挡住改名。后台日志不再把 `stopped`（被停止或被后续操作取代）记成错误。**有意保留的语义：** 客户端请求已经排队等方案 A 时切到 B，这个请求仍然加载 A（它在请求时就选定了方案），切换只影响之后的请求；需要时再定。新增测试：其他模型 drain 中、m 手动启动 A 排队、切 B → 最终 `B:ready`、从未启动 m:A、手动启动以 `stopped` 结束、队列只剩 m:B、`inUse` 只有 B；排队的客户端请求在切换后仍加载 A；手动启动排队中保存方案 → `restartIfUp` 为空，排队的启动照常加载；Scheduler 层 `cancelManual` 只撤回手动调用方、留有请求的任务照常加载、只剩手动调用方的任务被丢弃。修复前新测试失败（`restarted` 为 false）。真实接口（构建产物 + 慢响应假 llama-server、临时数据目录）复现本条场景：切换返回 `restarted: true`，队列变为 `[mmm:RP]`，最终 `mmm:RP ready`，日志只有 `starting other:默认`、`starting mmm:RP`，没有错误。

## CR-002 · 已关闭 · 中 · 深度输入保持字符串，原 TypeError 不再出现

**证据：** `app/components/SettingsDirs.vue:26` 使用 `String(r.depth).trim()`；`:51` 在 `update:model-value` 将数字转回 string，null/undefined 转为空串。没有新增组件级自动化测试，修复方的浏览器验证说明与代码一致。

本次提取旧版和新版实际 badDepth 表达式，在内存中输入 4、5、11、空串和 undefined：旧版数字及 undefined 抛 TypeError；新版 4/5 返回 false（合法），11/空串/undefined 返回 true（非法），没有异常。这是原失败条件的旧失败、新通过对照，不是浏览器输入事件端到端实测。UI 输入边界的 String 转换另经源码检查。建议后续建立前端测试设施时保留此回归场景，当前不以缺少设施阻止本条关闭。

## CR-003 · 已关闭 · 中 · 排队与待重启方案均受占用保护

**证据：** `server/core/model-ops.ts:70-75` 合并实例、Scheduler queue/current job 和 pending restart；`server/service/models-api.ts:25` 的 assertProfileFree 与 `server/api/models/[id]/profiles.post.ts` 的 rename/delete 分支同步使用该检查。检查到配置提交之间没有 await，正常同进程并发请求不能插入这一段。

实际删除处理函数的旧/新对照：A 有租约、B 排队等待 A drain，删除 B。

```text
48980ee：删除成功；等待 B 的请求 failed:profile-missing
de19233：删除返回 409；等待 B 的请求 ready
```

改名共享相同 busy 检查。`tests/core/model-ops.test.ts:94` 开始的 queued in-use、`:108-115` 的 pending target in-use 测试通过；抽屉增加 inUse 并监听队列变化，按钮按该集合禁用。新增测试针对新 ModelOps，不能字面移到旧版运行；实际接口对照证明旧保护会允许删除。没有单独启动浏览器确认排队时按钮禁用效果，本条关闭以服务端防护和接口复现为依据。

## CR-004 · 已关闭 · 中 · 未读缓冲有界，活动顺序和清理路径有效

**证据：** `server/core/live.ts:225-247` 依据 desiredSize 缓冲，活动上限默认 200，snapshot 仅保留最新一份；`:250-268` 超限/取消/abort 清订阅、两个 interval、held 队列和 abort listener；`:270-272` 由 pull 补发，流内队列默认 16 个 chunk。

本次将 `tests/core/live.test.ts:164-213` 新增的三条测试原断言在内存中分别绑定旧 live.ts 和当前 live.ts 执行，没有改测试文件：

| 新增测试 | 旧实现 | 新实现 |
| --- | --- | --- |
| 慢 reader：活动有序、最终 snapshot 最新 | 失败（最终 inflight 预期 5，实际 1） | 通过 |
| 活动超限关闭连接并解除订阅 | 失败（subscriberCount 预期 0，实际 1） | 通过 |
| 多连接取消后解除订阅 | 通过 | 通过 |

第三条不能单独证明旧版缓冲无界已修复：旧版本来就能在取消时清理；前两条具有旧代码失败的证据。

另以不读取的连接推送 10,000 条事件、highWaterMark=4、maxPendingActivity=50 对照：旧版仍订阅且留下 10,003 个 chunk；新版已解除订阅，只留下 4 个 chunk。临时计数 wrapper 观察两版各创建 2 个 interval，结束时均清除 2 个；新版本在超限关闭时已经清理。所有响应最终取消，没有残留测试连接或 interval。

**丢事件/顺序边界：** 未超限时 heldActivity FIFO，现有 20 条事件测试未发现活动丢失或活动间乱序；snapshot 合并及放在 held activity 后补发是明确策略，不保证 snapshot 与 activity 严格交错复刻。超限时 cleanup 会丢弃尚未发出的 heldActivity，重连 history 只有最近 50 条，**不能保证恢复全部丢弃事件**。对本阶段“最近事件+当前状态”的有界 UI 可以接受，但不得声称该流具有可靠全量事件重放能力；以后若承载完整日志，应另做 cursor/replay。没有进行网络慢连接 RSS 或生产 Bun.serve 压力验证。

- **处理（2026-09-30）：** 同意边界说明：超限断开时丢弃的事件不保证能从 history 补回，`/api/stream` 只承担「最近事件 + 当前状态」，不作为可靠的全量事件流；阶段 3 的日志页如需完整记录，走落盘日志而不是这个流。本轮不改代码。

## CR-005 · 部分解决 · 中 · 原 ampersand 路径已转义，新增边界见 CR-007

**证据：** `server/core/launch.ts:108-110` 在 Windows 调用 formatCmdCommand；`server/core/args.ts:318-329` 增加 CMD/原生参数转义。界面文案明确指定 CMD，避免把 PowerShell 当作同一语法。

原始 `X:\models\A&B.gguf` 现输出 `X:\models\A^&B.gguf`，对应新增跨平台 args 测试通过。`tests/platform/cmd-preview.test.ts:12-20` 使用真正 cmd.exe 与 argv 夹具，断言回读数组，验证方式比字符串比对有效；已有 Windows 处理记录报告该四条通过，本机没有重新执行它们。旧 formatCommand 对原 & 场景的输出没有转义，当前生成结果可以区分旧/新；**本次未取得这四条测试在旧 formatter 下的真实 Windows 失败输出**，不能声称已独立完成 Windows 红绿验证。直接将旧版缺失的函数导入失败算红灯也不成立。

仅含括号的参数未触发转义，现有测试中的括号恰好同时包含 & 和空格，掩盖这个分支遗漏，见 CR-007。因此本条不完全关闭。其他需补验证的边界：exe 路径自身含空格与元字符（项目路径或 LLAMA_WEB_DATA 可以含它们）、明确 /v:on 与 /v:off 的 ! 参数、交互粘贴与 `cmd /d /s /c` 的入口差异。本次不将这些未执行的边界逐个定性为确定缺陷。

- **处理（2026-09-30）：已修复余项。** 在 Windows 上用真实 cmd.exe 核对了本条列出的边界：程序路径含空格 + `&` + 括号时，原来给引号加 `^` 的写法失败（cmd 找程序名时不认 `^"` 分组）；程序路径含 `;` / `,` 但不带引号时也失败（cmd 在它们处切分程序名）。新增 `quoteCmdProgram`：程序路径只要含空白或 `( ) & | < > ^ % ! ; , =` 就用普通双引号包起来（Windows 路径不能含引号），不加 `^`。新增真实 cmd 测试：用硬链接把 bun 放进名为 `a b`、`a&b`、`a b&c (x)`、`p100%`、`semi;co,ma=eq` 的目录执行预览命令，参数全部读回一致；修复前 `a b&c (x)` 和 `semi;co,ma` 两种在同样的探测中失败。参数中的 `; , =` 已确认原样传递。**仍未覆盖，列为限制：** 开启延迟扩展（`cmd /v:on`）时的 `!`（CMD 默认不开，界面说明写的是普通 CMD）；程序路径里恰好出现已定义变量的 `%名字%` 成对写法会被展开；交互窗口粘贴与 `cmd /d /s /c` 的差异没有自动化验证（两者都按命令行规则而不是批处理规则解析 `%`）。

## CR-006 · 已关闭 · 低 · 宿主路径测试在 macOS 通过

**证据：** `tests/core/settings-admin.test.ts:11-16` 用 resolve/join 构造宿主绝对路径；大小写语义独立为 Windows test.if。macOS 全量 bun test 为 253 pass / 12 skip / 0 fail，针对性测试也无失败，上一轮稳定的 7 条设置测试失败不再出现。

这里修改的是测试输入，产品 settings-admin.ts 没有改变；把修正后的测试绑定旧产品函数也应通过，不应要求它们在同一旧产品函数上失败。红灯来自上一轮旧测试自身的宿主路径错误，绿灯来自本次修正后的测试。没有重跑 Windows 大小写专项。

## CR-007 · 中 · quoteCmdArg 漏掉“仅括号”分支（Windows 执行待确认）

**位置：** `server/core/args.ts:320-323`；覆盖不足位于 `tests/platform/cmd-preview.test.ts:24-26`。

**问题描述：** 外层检测正则不含 `(`、`)`，虽然内层替换正则包含它们，只有参数同时含其他触发字符时才会进入替换。既没有空白/引号、也没有 & 等字符的括号参数会原样输出。[Microsoft CMD 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd) 明确将括号列为传参时需要转义或加引号的特殊字符。

**触发场景与证据：** 实际调用 quoteCmdArg 得到 `(abc)`→`(abc)`、`)`→`)`、`X:\models\A(1).gguf`→同样未转义的路径。可通过额外参数传入独立的 `)`，或使用含括号但无空格的文件名。这与 formatter 的 CMD 安全传参契约不符；在具体 cmd.exe 语境下究竟语法错误、分组或如何改变 argv，需要真实 Windows 回读，**本次执行结果待确认**。不据此声称自动启动有命令注入：自动启动仍使用参数数组。

**建议修改：** 将括号纳入需要 shell 转义的检测集合，并补真实 CMD 的 `(`、`)`、`(abc)`、无空格括号路径回读测试；不能只保留含 `&`/空格的括号测试。先在目标 shell 验证后决定最终转义写法，保持原生 argv 的引号/反斜杠语义。

- **处理（2026-09-30）：已核实，不构成错误；仍按建议加固。** 在 Windows 上用真实 `cmd /d /s /c` 执行旧代码生成的预览命令：`(abc)`、`)`、`(`、`X:\models\A(1).gguf`、`--foo ) bar`、`a)b(c` 回读都和原数组一致，说明在顶层命令行里单独出现的括号不会被 cmd 解释；只有把命令粘贴到 `if (...)`、`for ... do (...)` 这样的括号块里才会出问题，预览不是这种用法。加固没有副作用，所以检测集合加入了 `( )`（参数里的括号一律加 `^`），真实 cmd 测试补了上述括号用例，全部通过；跨平台单测补了 `A(1).gguf` 与单独的 `)`。

## 其他范围与验收说明

最新交接已主动披露“空字符串 SelectItem”问题，计划也新增未完成任务。这是此前 UI 的已知独立问题，本次不把它归因于 de19233、也不重新编号；它仍影响“无/不传/内置模板”的选择，阶段 2 关口不能忽略。计划核心状态机、来源规则没有因本次修复变更。公网鉴权仍属阶段 4，本轮没有验证该未实现链路。

## 实际命令、结果与未运行验证

环境：macOS arm64、Bun 1.3.11。未读取真实 secrets、未启动 GPU 模型。临时复现脚本均以 bun -e 在内存运行；假进程只实现 ModelProcess，没有启动真实 llama-server；Scheduler 执行 shutdown，响应取消，临时计数 wrapper 恢复。正常测试自己的临时文件按其清理路径回收。

| 实际命令/验证 | 结果 |
| --- | --- |
| `git status --short`、`git log -5 --oneline`、首次 `git show --stat de19233` | 起点干净；最初本地缺修复提交，git show 失败 |
| `git fetch origin`、`git show --stat de19233`、`git log --oneline HEAD..origin/main`、`git merge --ff-only origin/main` | 获取并快进到指定修复提交 |
| `git diff 48980ee..de19233 -- server app tests i18n` 及针对性 diff/read/nl | 核对实现、接线与测试，行号来自该提交 |
| `bun test` | 253 pass / 12 skip / 0 fail，共 265 tests、23 files，退出码 0 |
| `bun run typecheck` | 退出码 0，通过 |
| `bun test tests/core/model-ops.test.ts tests/core/live.test.ts tests/core/args.test.ts tests/core/settings-admin.test.ts tests/platform/cmd-preview.test.ts` | 59 pass / 5 skip / 0 fail，共 64 tests、5 files，退出码 0 |
| `bun -e` 原始接口场景旧/新对照、排队管理启动场景、深度表达式、SSE 上限/interval 计数、CMD 括号输出 | 得到各条列出的结果；旧源码通过 `git show 48980ee:<path>` 读取并转译，在内存执行，未改磁盘代码 |
| `bun -e` 内存执行新增三条 SSE 背压测试原断言，分别绑定旧/新 live.ts | 旧版 2 fail / 1 pass，新版 3 pass；预期旧版失败被复审 harness 捕获，不是当前仓库测试失败 |
| Microsoft 官方 CMD 文档读取 | 核实括号属于要求转义/加引号的参数特殊字符 |
| `git diff --check`、`git status --short` | 写报告前无修改、无空白错误；提交前再检查本报告 |

首次内存旧源码加载尝试使用 data URL，Bun 1.3.11 不支持该方式，报 NameTooLong；改用内存转译后的 async function 加动态 import 后成功。没有通过安装运行时或写临时源码绕过限制。

**未运行：** build、真实浏览器输入/按钮交互、真实 Windows cmd.exe/PowerShell 回读、Windows 进程树/残留清理、GPU、酒馆、实际粘贴预览命令运行 llama-server、网络慢连接压力及完整日志重放。12 个全量 skip 包括 4 条 CMD 测试、Windows 路径大小写专项及原有 Windows 平台检查。本次成功的跨平台测试不能替代这些验证。

下一步：处理 CR-001 队列余项，核实并处理 CR-007，再完成已登记的下拉空值任务和阶段 2 待验收项；仍应停在阶段 2 关口，不建议直接进入阶段 3。
