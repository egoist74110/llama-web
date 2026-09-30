# 阶段 2 Codex 审查

- 日期：2026-09-30。
- 结论：**rework required（需要修正）**。共 6 条：高 1、中 4、低 1；CR-005 的 Windows shell 实测标为待确认。
- 范围：`7b5d363..9c41d4f`，依次为 `9c6f737`（2-1）、`7bde49a`（2-2）、`6a01c46`（2-3）、`9c41d4f`（2-4）。行号均对应 `9c41d4f`。
- 已读取 AGENTS.md、计划的核心行为规则、阶段 2 任务和验收标准、开发指南、最新交接。关联读取阶段 1 调度器、参数构建器、来源检查和测试，以核实阶段 2 调用链。
- 本次只新增此报告，没有修复代码、修改测试、计划或交接记录。开始时工作区干净；本地原停在 `7b5d363`，获取远端后快进到 `9c41d4f`。

## CR-001 · 高 · draining 期间切回原方案，旧后台操作仍启动过期方案

**位置：** `server/api/models/[id]/profile.post.ts:17-25`；相同后台 stop/start 模式见 `server/service/models-api.ts:32-38`。

**问题描述：** 接口用当时的实例快照决定是否重启，随后把目标方案捕获到后台闭包。后续修改没有取消或使旧闭包失效。draining 的原方案被当作“已在运行”，切回它时返回 `restarted: false`，但上一轮等待 drain 的闭包仍会启动另一方案。违反“切换当前方案即重启”的规则，配置与实际进程分离。

**触发场景：** A ready 且有在途请求；切到 B 后 A draining；在请求结束前切回 A；最后释放 A 的请求。用内存 AppContext、真实 Scheduler、实际 `profile.post.ts` 处理函数与假 ModelProcess 执行，结果为：

```text
切到 B：{ ok: true, restarted: true }
切回 A：{ ok: true, restarted: false }
最终：activeProfile = A，实例 = B / ready
```

新请求使用基础名又会切回 A，增加一次无意卸载和加载；界面上的停止操作也缺乏使此前后台重启失效的机制。

**建议修改：** 为每个模型统一管理操作的顺序和目标版本；stop 等待完成后，只有仍有效的启动意图才能继续。切换、保存并重启、手动停止应共享取消/序列化机制，不能只按旧快照判断。补充实际管理处理函数的 A→B→A draining 测试，以及重启等待期间手动停止测试；现有 scheduler 单测与纯 `switchProfile` 测试没有覆盖这一组合。

## CR-002 · 中 · 修改扫描深度后，数字值调用 trim 导致设置卡片报错

**位置：** `app/components/SettingsDirs.vue:25`、`:50`。

**问题描述：** `Row.depth` 声明为 string，`badDepth` 调用 `r.depth.trim()`；但绑定 `UInput type="number"` 的直接 v-model 会写入 number。已安装的锁文件版本 Nuxt UI 4.11.2 在 `Input.vue` 的 `updateInput()` 中对 number 类型执行 `looseToNumber(value)`。TypeScript 声明不能改变运行时值。

**触发场景：** 在设置页添加或编辑目录，将深度从 3 改成 4，下一次渲染/计算 invalid 时抛异常。直接提取仓库中的 `badDepth` 表达式，以组件会收到的 `{ depth: 4 }` 执行，得到 `TypeError: r.depth.trim is not a function`。本次未做浏览器交互实测，但输入组件源码与表达式已核实。影响目录编辑、保存按钮和校验，属于阶段 2 的核心配置路径。

**建议修改：** 和 `SettingsImage`、`SettingsServer` 一样，在 `update:model-value` 边界统一转换成字符串，再校验；覆盖键盘输入、步进按钮和清空值。增加 UI 控件值类型的回归验证，纯后端 `applyModelDirs` 测试无法捕获此问题。

## CR-003 · 中 · 方案改名/删除保护忽略已有排队请求

**位置：** `server/api/models/[id]/profiles.post.ts:21-24`、`:35-45`；`server/service/models-api.ts:22-25`。

**问题描述：** busy 只查询 `snapshot().models` 的 loading/ready/draining/unloading 实例。一个目标已经进入切换队列、正在等其他目标 drain 时，还没有自己的实例，因此可以被改名或删除。队列保留原目标，最终启动时只能报方案不存在；管理接口仍向用户报告删除成功。

**触发场景：** M:A 有在途请求，另一个客户端请求 M:B；A draining、B 已在 queue（即使 `started: true`），此时删除 B。用实际 `profiles.post.ts` 处理函数、真实 Scheduler 和假启动器复现：删除返回 `{ ok: true }`；释放 A 后，原 B 请求结果为 `failed:profile-missing`。改名会产生相同失效路径，并留下旧名字的 failed 实例。

**建议修改：** 在管理提交点把 queue/current job 中被引用的方案也视为 in-use，返回 409；如果确实要允许操作，应明确取消并通知等待者，而不是让加载阶段失败。前端保护也应使用队列信息。补充“请求排队等待 drain 时删除/改名”的接口与 scheduler 集成测试。

## CR-004 · 中 · SSE 不处理背压，慢连接的未读事件队列无限增长

**位置：** `server/core/live.ts:203-213`、`:228-230`。

**问题描述：** 每次事件和心跳都无条件 `controller.enqueue()`，没有检查 `desiredSize`、等待 pull、合并未读快照或设置队列上限。连接尚未断开时，cleanup 不会触发；history 的 50 条上限只限制历史数组，不限制每条 SSE 响应流。慢客户端能持续占用增长的内存。

**触发场景：** 客户端暂停读取但维持连接，模型状态持续变化或心跳持续产生。本次用 `handleStream()` 创建响应，不读取 body，然后同步产生 10,000 条状态事件：随后读到了 10,003 个已排队 chunk，共 1,419,070 字节，history 仍仅 50 条。取消 reader 后 subscriberCount 回到 0，说明普通取消清理有效，缺陷在连接存续期间的缓冲策略。该复现为 Web Stream 层验证，没有启动网络服务器测 RSS。

**建议修改：** 设定每连接有界缓冲；背压期间只保留最新 snapshot，activity 使用有界队列，超限时关闭连接并让 EventSource 重连获取 history。共享状态轮询也可由 hub 持有，避免每连接一个 poll。补充慢 reader、多连接、超限及取消后的资源释放测试。

## CR-005 · 中 · 复制预览命令不满足 Windows shell 的转义规则（shell 实测待确认）

**位置：** `server/core/launch.ts:103-104`；关联 `server/core/args.ts:302-309`、`app/components/ProfileForm.vue:141-145`。

**问题描述：** 阶段 2 将 `formatCommand()` 的输出作为可复制执行的命令，但格式化器仅为包含空白或引号的字符串加双引号，对 CMD 元字符未转义，也没有声明目标 shell。`splitArgs()` 的往返测试只能证明项目自有解析器可读，不能证明命令行手动执行与参数数组启动一致。

**触发场景：** 模型文件为合法的 Windows 路径 `X:\models\A&B.gguf`，格式化输出中它仍不带引号：

```text
X:\app\llama-server.exe --model X:\models\A&B.gguf
```

在 CMD 中 `&` 是命令分隔符，不能作为这个参数原样传递；含空格的 exe 路径在 PowerShell 下还需要调用运算符。上述字符串生成已实际执行验证；本次 macOS 环境没有 cmd.exe / Windows PowerShell，目标 shell 执行及参数回读**待确认**。正常路径的字符串比对不能替代这项验收，也不代表自动启动存在 shell 注入——自动启动仍使用参数数组。

**建议修改：** 明确预览对应 CMD 或 PowerShell，使用该 shell 的可执行文件调用语法与参数转义；覆盖空格、`&`、`%`、引号和尾部反斜杠。用真正的目标 shell 执行 argv 回显夹具，比较回读数组，再执行预览命令验收；不要仅比较进程命令行字符串。

## CR-006 · 低 · 新设置测试使用固定 Windows 路径，阻断 macOS 全量测试

**位置：** `tests/core/settings-admin.test.ts:33-63`；同类路径位于 `:71-86`、`:165`。

**问题描述：** 测试将 `X:\models` 等固定 Windows 路径交给使用宿主 `node:path.isAbsolute()` 的 `cleanPath()`，又期望继续验证目录 id、depth、enabled 等逻辑。macOS 上这些路径先被判为相对路径，7 条测试提前失败。重复路径测试虽然按平台分支选择期望值，也没有解决其输入本身在非 Windows 上无效的问题。属于测试可移植性问题，不据此认定 Windows 产品的目录校验有误。

**触发场景：** macOS 执行 `bun test`，稳定出现 7 条设置测试失败；针对 settings/live/scheduler 的重跑同样有 7 条设置失败。

**建议修改：** 通用逻辑测试使用宿主绝对路径或临时目录；Windows 大小写和盘符语义通过注入 path/platform 或明确的 Windows 专项测试验证。恢复跨平台全量测试可用性，避免把其他真正的回归混入已知失败。

## 验证记录与边界

环境：macOS arm64、Bun 1.3.11。没有读取真实 secrets/config，没有启动真实 llama-server 或占用 GPU。内存复现使用构造配置和假 ModelProcess；所有 scheduler 都执行 shutdown，SSE reader 已取消，未保存临时脚本。

| 实际命令/验证 | 结果 |
| --- | --- |
| `git status --short`、`git log --all --oneline -45`、`git ls-remote --heads origin`、`git fetch origin`、`git log --oneline HEAD..origin/main` | 定位远端阶段 2 四个提交，本地起点干净 |
| `git merge --ff-only origin/main` | 快进到 `9c41d4f` |
| 首次 `bun test` | 231 pass / 7 skip / 9 fail；7 条 settings 路径失败，另有 scheduler crash 的 reason 断言和 live polling 快照断言失败 |
| 首次 `bun run typecheck` | 因本地未同步安装 `@nuxt/ui` 而失败，属于依赖未安装 |
| `bun install --frozen-lockfile` | 成功安装锁文件依赖，nuxt prepare 成功；没有修改 package.json 或 bun.lock |
| 再次 `bun run typecheck` | 退出码 0，通过 |
| `bun test tests/core/live.test.ts tests/core/scheduler.test.ts tests/core/settings-admin.test.ts` | 49 pass / 7 fail；live 与 scheduler 通过，settings 仍有 7 条路径失败 |
| 第二次全量 `bun test` | 233 pass / 7 skip / 7 fail；剩余均为 CR-006；不能报告全量通过 |
| `bun -e` 内存复现：实际方案切换接口、实际删除接口、SSE 未读缓冲、提取的 badDepth 表达式、命令格式化 | 分别得到 CR-001 至 CR-005 所列输出；首次切换复现脚本有括号语法错误，修正内存脚本后成功执行，未改仓库代码 |
| `git diff --check` | 写报告前通过；交付前再核验报告 diff |

首次出现的两个额外断言失败未在针对性重跑与第二次全量中出现，原因**待确认**，不能据此宣称已修复或确定产品存在相应回归。7 个 skip 为 Windows 进程树、真实残留清理、解压等平台验证。

安全检查：阶段 2 新管理接口继续使用 `/api/*` 来源检查；局域网免 key 是既定规则，未按多用户鉴权要求提出意见。文件修改从服务端重扫结果选择，模板保存从现有文件列表校验，自动进程启动保留参数数组。`git ls-files data` 为空；阶段 2 代码与文档检查未发现新增真实 key、个人路径或隧道配置。未进行全历史秘密扫描，不把检查结果表述为仓库绝对无秘密。公网 `:8080` 与 key 管理属于尚未实现的阶段 4，本次没有可执行的公网鉴权链路，不把该阶段功能缺失列为阶段 2 缺陷；CR-004 涉及的是局域网管理 SSE 的资源边界。

本次没有运行 build、真实浏览器交互、Windows shell、Windows 进程树或 GPU/酒馆真机验收。最新交接自己也明确未验证“新放 gguf”“酒馆实际连接”“复制命令手动运行”和长时间深色体验；已有字符串比对与模型调用证据不能代替这四项全部验收。阶段 2 是否通过需在处理以上意见并补齐验收后决定，当前不建议开始阶段 3。
