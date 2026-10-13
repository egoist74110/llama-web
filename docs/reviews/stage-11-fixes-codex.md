# 阶段 11 修复复审 · Codex · 第 2 轮

日期：2026-10-13。整体结论：**rework required**，依据是 CR-002 仍存在已复现的语言一致性缺陷。CR-004 的构建入口验收另受环境阻塞，不能用源码/内存验证冒充正式入口通过。

## 范围和工作区

沿用上一轮 [stage-11-codex.md](stage-11-codex.md) 的 CR-001～CR-006。遵循 code-review skill 的 closure review：先核验原触发条件，再检查修复差异和相关调用链，没有重新审查整个阶段。

`git log -1 --oneline` 为 `0e8c582`，与用户给定基线一致。`git diff HEAD` 是未提交修复：9 个 tracked 文件，88 行新增/23 行删除；另有新增测试 `tests/app/use-settings-stale.test.ts`。上一轮报告是原有 untracked 文件。本轮只新增本报告，未修改实现、测试、计划、交接或上一轮报告；没有提交、推送、切分支。

## A · 逐条判定

| 编号 | 本轮判定 | 依据 |
| --- | --- | --- |
| CR-001 | **已关闭** | 原来的 detail 出口已删除，相关异常进入 onEvent；外部异常仍先遮挡 key |
| CR-002 | **仍未完全关闭** · major | 原旧 GET 场景修复；旧 POST、新旧 SSE 仍缺版本判定；三次重读耗尽静默结束 |
| CR-003 | **已关闭** | 两个普通 forward 分支均不再复制上游 statusText；Node/h3 内存复验通过 |
| CR-004 | **仍未完全关闭：验收待确认** | 源码及内存原触发场景已修，未发现这项修复引入新缺陷；build 失败，无法完成要求的构建入口 HTTP 实测 |
| CR-005 | **已关闭** | own property 查询、中英测试及原合法名称/数据值复验通过 |
| CR-006 | **已关闭** | 原三组语言偏好均选 en；额外顺序/回落场景通过内存复验 |

### CR-001 · 已关闭：合成错误与服务端诊断分离

位置：`server/core/proxy.ts:305`、`:307`、`:578`、`:579`、`:591`、`:592`、`:593`、`:653`、`:654`；日志接线 `server/service/context.ts:199`、`:209`、`:213`。

本地 fetch 失败：原异常对象进 upstream-error，客户端只有当前字典的 upstreamUnreachable。两处预处理 catch：原异常对象进 internal-error，客户端只有 preprocessFailed。外部 fetch 失败：异常 message 先由 redactText 遮挡 key，再以新 Error 进入 upstream-error，客户端只插入上游名。保留的是遮挡后的诊断 message，不是未遮挡异常对象或原 stack，这是原有安全处理的延续。

独立内存验证用真实 createProxy/handleV1、构造模型及异常，断言本地 fetch 502、本地和外部预处理 500 均无诊断原文/占位路径，且 onEvent 捕获对应原异常对象；外部 fetch 502 的事件保留诊断文字但没有构造 secret，响应也没有 detail。调用链已接到 logError；未启动完整应用观察真实控制台输出。

字典逐行比对结果：中文仅三个值删除尾部 `：{detail}`，英文仅对应三个值删除 `: {detail}`；没有其他文字改动。即删除占位符及其分隔符，不是只删除花括号文本却留下冒号。中英剩余占位符分别为 `{model}`、`{upstream}`、无占位符。parity 本轮 1840/1840，硬失败测试通过。

“全部经 onEvent”成立于本项修复的 fetch/预处理错误分支及新 handleV1 catch。不能扩写成“proxy 的每一种异常都日志化”：已开始流式 body 的 `pull` catch（`:383`）仍只结束转发并 ctrl.error，没有 onEvent；它不是本项原 detail 响应出口，也没有因此新添客户端错误文本。

### CR-002 · 仍未完全关闭：计数只防旧 GET，不能为所有通道排序

位置：`app/composables/useSettings.ts:24`、`:27`、`:33`、`:44`、`:47`；`app/composables/useLocale.ts:15`、`:25`；`app/composables/useLive.ts:36`、`:43`。严重度：**major**；三次耗尽的静默失败是修复新增的有限范围问题，仍记在本编号下。

原“旧 GET 晚于 save 和新快照”已经修复。新增测试 `tests/app/use-settings-stale.test.ts:29` 和普通加载用例 `:47` 本轮实际通过，但仅覆盖这两种顺序。

**剩余触发 1：其他窗口更新后，旧 POST 覆盖最新快照。** A 窗口初始英文，发保存中文；服务端写中文并生成 A 的 POST 响应，但该响应延迟。B 随后保存英文；A 按顺序收到中文、英文 SSE，界面已是英文。最后 A 的旧 POST 中文响应到达，save 无条件覆盖 doc/locale。本窗口 saves 计数只递增，不用于校验 POST；localeSwitches 同样只在 GET 中检查。

验证：以 Vue ref 和可控 Promise 桩运行真实 useSettings，并以 EventSource 桩运行真实 useLive 的 snapshot handler。上述顺序得到 `OLD_POST_AFTER_OTHER_WINDOW zh-CN doc zh-CN`，断言通过。`saving` 只保护当前窗口，不能约束 B。这不是“两个 SSE 帧逆序”的假设；SSE 帧仍按服务器顺序到达，乱序发生在 HTTP 与 SSE 之间。服务端最新为 en 时，后续轮询若没有状态差异会被 lastKey 去重，不能保证立即修正这个客户端。

**剩余触发 2：旧 SSE 晚于新 save 响应。** 真正的 snapshot handler 无版本检查，保存 en 后投递此前的 zh-CN snapshot，内存得到 `OLD_SSE_AFTER_SAVE zh-CN doc en`；随后新 en snapshot 到达才恢复。这个场景通常是暂时回跳，不应夸大为一定永久错误。

LiveHub 定时合并并没有捕获旧 settings 文档：`server/core/live.ts:298` 的回调在触发时执行 `this.snapshot()`（`:300`），context 的 snapshot getter 每次读取 `getSettings().ui.locale`（`server/service/context.ts:395`）。真实 LiveHub 内存探测先 notify、再将 getter 所读 locale 改为 en，定时器推送 en。**所以“保存后尚未触发的合并定时器带旧文档”未成立。** 但此前已生成的 snapshot 帧仍可能在 ReadableStream/网络队列中晚于 POST 送达；handleStream 在 `server/core/live.ts:460` 序列化帧，队列和最新 heldSnapshot 不是 HTTP 响应的排序屏障。

**新增触发 3：三次重读都过期后静默结束。** 每次 GET 等待期间都收到一次真实语言切换，三次全部 continue；循环耗尽后仍执行 `loadError.value=''`，既不应用文档，也不报错/安排重试。首次设置加载时 doc 仍 null，页面卡片无法加载且没有错误提示。

验证：真实 composable 连续三次 GET，逐次由 snapshot handler 切换语言后完成该 GET；实际输出 `THREE_ATTEMPTS_EXHAUSTED {"requests":3,"doc":null,"error":""}`。设置页只有 mounted load，快照不会填 settings-doc，见 `app/pages/settings.vue:5`、`:6` 和 useLive 的处理。

建议方向：HTTP 设置文档与快照共享服务端单调配置版本，统一校验 GET、POST、SSE。重读耗尽必须保留明确失败状态或安排后续获取，不能宣称成功。仍不建议只给 GET 加更多本地计数。

### CR-003 · 已关闭：普通 forward 不再复制 statusText

位置：`server/core/proxy.ts:363`、`:396`；开发路由 `server/routes/v1/[...path].ts:5`。

有 body、无 body 两条分支都构造 `{status,headers}`，删除上游 statusText。内存 fetch 分别返回带 `Upstream Exploded` 的两种 Response；真实 proxy 均不含该短语，再经已安装 h3 的 sendWebResponse 状态处理验证，Node statusMessage 同样无该短语。body 仍按原约定转发，不作翻译。未启动完整 nuxt dev/Node socket。

### CR-004 · 原缺陷源码已修；构建入口验收仍待确认

位置：`server/core/proxy.ts:105`、`:542`、`:545`、`:546`、`:604`；原生入口 `server/entry.ts:38`。

独立内存验证：`GET /v1/models/%ZZ` 得到 404 OpenAI JSON `model_not_found`，英文文案包含字面名称 `%ZZ`；以出错的 Request body stream 触发真正的外层 catch，得到 500 `internal_error` 当前语言 JSON，异常对象进 internal-error 事件，客户端没有异常原文。

**流式响应已开始后的行为**：外层 await 只包住 handleV1Inner 返回 Response 的阶段，不会捕获此后 ReadableStream 的 pull 失败，也不会把已发送的 200 改成另一个 500 JSON。独立内存验证 ready 流先读到一块 SSE，再让上游 body 出错：仍是原 Response 的 status 200，后续 body read 拒绝，lease 恰好释放一次，没有在已发 body 后拼入新的 500 JSON。冷加载路径的异步任务也在外层 catch 之外，但已有分支处理 acquire/fetch 失败；以通用 acquire 异常复验得到 200 SSE + 当前语言 internal_error 事件，原异常不进入数据。实际网络连接如何表现未实测；不能把内存 reader 拒绝等同于已观察到 socket 断开。

这些流式行为是既有分支，未发现外层 catch 修复引入新的重复响应或文案泄漏。未知 body pull 错误不经 onEvent 的边界见 CR-001。

**要求的构建产物 HTTP 验证未完成**：实际执行 `bun run build` 后，Nuxt 打印版本信息，再报 `ERROR: SecItemCopyMatching failed -50`，以 SIGSEGV、exit 139 退出。`bun run typecheck` 同样失败。当前权限策略禁止提权，未重试沙箱外构建。未将已有 `.output` 当作本轮修复产物，也未启动 `PORT=... bun .output/server/index.mjs`；需要在可成功构建和监听的环境实测 `/v1/models/%ZZ` 及未知错误分支。这里的“仍未完全关闭”指验收阻塞，**不是新增的已确认实现缺陷**。

### CR-005 · 已关闭；测试覆盖原触发条件

位置：`app/utils/profile-label.ts:13`；`tests/app/profile-label.test.ts:28`。

Object.hasOwn 拦住继承属性；新增测试在中英两种语言下断言 toString/valueOf 保持原名，本轮通过。另以内存调用 profileItems 验证两种语言的 label/value，合法原型同名方案的 value 仍是原名；默认方案仅英文 label 为 Default。未发现保存或路由值回归。

### CR-006 · 已关闭；无新增仓库测试，独立探测覆盖原场景

位置：`desktop/ui/launcher.js:7`、`:9`、`:10`。

从当前 launcher 源码提取原选择表达式执行：`['en','zh-CN']`、`['en-US','zh-CN']`、`['en-US','zh-TW']` 三个原触发条件均得到 en。补查 `['zh-TW','en-US']` 得到 zh-CN，未知语言、空列表均回落 zh-CN。没有写 settings；无须第三种语言参与即可证实偏好顺序已修。未运行桌面壳；这项修复没有新增仓库测试，证据是本轮独立断言探测。

## B · 三个边界项的事实判定

### B1 · 未发现中文未知异常进入 activity reason 的真实调用链

原文保留机制确定存在：`server/core/live.ts:117`～`:121` 先 diagnose，未知时选 code/message；`app/composables/useFormat.ts:37`～`:39` 对未知值原样显示，`:83` 插入当前语言事件模板。但是，**本轮没有找到项目实际产生中文未知 Error 并走入这条 activity 链的场景**，不能把上一轮人工注入中文 Error 当成真实可达性证明。

已追踪的真实链是：`server/service/context.ts:425` 的 launch → `server/core/scheduler.ts:605` → catch `:624`～`:627` → setState/emit `:692` → context `:421` → LiveHub `:197` → errorText → useFormat eventText。启动配置异常 LaunchConfigError、Runner 的 LoadError/崩溃均可诊断成固定 kind（`server/core/errors.ts:58`～`:80`）；不会靠其原中文 message 显示 reason。源码中文搜索没有发现这条 launch 链直接创建中文 message 的 Error。

两个容易误认的候选也不能证明：

- `server/core/model-facts.ts:51` 的 `Error('cannot read '+abs)` 可包含中文目录，但 `server/service/model-check.ts:74` 捕获并返回 null，不会传给 scheduler state error。
- `server/service/admission.ts:80` 的 StartRefused 可使用中文 i18n 文案，但 checkedStart 在 `:62` 转成管理接口错误；它不走上述 launch→state activity 链。

本轮未运行 Windows 本地化系统异常、真实模型或第三方依赖故障，因此不能保证所有外部异常永远没有中文。当前结论为“未发现真实场景”；是否将未知 reason 统一为通用文案，由用户决定，未新增发现编号。

### B2 · 第三语言实际需要的注册/验证点

“只加 LOCALES 一项和一个文件”按现状不能字面成立：

| 位置 | 需要的动作 |
| --- | --- |
| `i18n/<新语言>.ts` | 新增完整或 fallback 合并后的字典文件，默认导出 Messages |
| `i18n/messages.ts:7` | 加入该字典的显式 import；现在只有 zh/en import |
| `i18n/messages.ts:35` | 给 LOCALES 加新 code，LocaleCode 自动扩展 |
| `i18n/messages.ts:47` | LOCALE_SHORT_NAMES 补新 code 的侧栏短名 |
| `i18n/messages.ts:49` | LOCALE_NAMES 补新 code 的完整名称；虽当前没有界面消费点，mapped type 仍要求它 |
| `i18n/messages.ts:57` | DISPLAY_LABELS 补新 code 的映射，必要时可为 `{}` |
| `i18n/messages.ts:60` | dictionaries 补新 code→字典注册 |
| `tests/core/i18n.test.ts:21` | 修改固定 `['zh-CN','en']` 的完整 LOCALES 断言，否则新增语言后测试会失败 |
| `tests/core/i18n-parity.test.ts:8`、`:56`、`:57` | 若新语言也必须满足 parity，注册其原始译文并纳入键/形状/占位符等检查；现状只查 enSkeleton/dictionaries.en，第三语言不会自动被检查 |

前三个映射和 dictionaries 的 mapped type 会因缺新 code 报类型错误。不能为了绕过类型检查而依赖运行时 fallback。默认语言无需为了增加第三语言而改变。

其余链路自动读表，无额外 locale 注册：settings 校验 `server/core/settings-admin.ts:293`、normalize `server/core/config.ts:382`；侧栏 `app/components/AppSidebar.vue:66`；桌面 strings 生成 `desktop/prepare.ts:62`；server/client 字典读取。未增加第三语言、未修改任何文件或试编译该场景。是否调整实现或决定 18 的文字，由用户决定。

### B3 · forwardExternal 的 secret 遮挡仍成立

**成立于既有外部 fetch 异常和响应转发路径**：`server/core/proxy.ts:591` 仍在事件前 redactText，`:596` 仍传 secret 给 forward，`:359`/`:360` 仍遮挡响应头和流；本轮真实 proxy 的内存断言验证了异常、header、跨两个 chunk 的 secret 都不会出现在客户端/外部 fetch 失败事件中，statusText 现在直接省略。

没有重复报告阶段 10 的 key 问题；没有连接真实外部服务。

## 本轮验证记录

| 实际命令 | 结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、`git diff HEAD --stat`、`git diff HEAD -- <指定文件>` | 确认基线及未提交范围，新增 stale 测试另直接读取 |
| `cat`/`sed` 读取 router、code-review、high、cleanup、cross-review、响应配置、AGENTS、前报告、plan、guide、handoff；`rg`/`nl`/`sed` 阅读相关源码 | 已完成原发现核验和 B 调用链追踪；少量定位不存在的 process.ts/commands.ts/memory-probe.ts 报错，后续以实际引用文件确认路径，未据此判断通过 |
| `bun test tests/app/use-settings-stale.test.ts tests/app/profile-label.test.ts tests/app/locale-view.test.ts tests/core/i18n-parity.test.ts tests/core/i18n.test.ts` | **29 pass / 0 fail**，exit 0；parity 1840/1840 |
| `bun test tests/core/proxy.test.ts tests/core/proxy-external.test.ts` | **5 pass / 63 fail**，exit 1；失败发生在测试启动临时 Bun listener，均为 EADDRINUSE/port 0 无法监听，本轮不能提权复跑；不能称该套转发验证通过 |
| `bun test tests/core/proxy.test.ts --test-name-pattern 'an unreachable llama-server\|a failure that is not a SchedulerError\|the cancelled branch\|bounded'` | 5 pass / 2 fail / 43 filtered out；宽泛 bounded 匹配到了两个需监听的流式测试，同样因端口限制失败 |
| 同命令将尾项缩窄为 `^bounded\(\)` | **5 pass / 0 fail / 45 filtered out**，exit 0；包括通用 scheduler 异常、cancelled、新 upstream-unreachable 用例及两个纯 bounded 用例 |
| `bun /private/tmp/stage11-closure-probe.ts` | exit 0，全部独立断言通过：真实 useSettings/useLive 乱序、三次耗尽、LiveHub 定时读取、原型同名方案、launcher、proxy 异常事件、Node statusText、malformed 路径、body 读失败、流式后续失败、外部 secret 跨块/头/事件遮挡 |
| Python 逐行比较 HEAD 字典与工作区字典 | exit 0；中英各仅 3 行，逐行恰为上述 suffix 删除 |
| `bun run build` | **exit 139 / SIGSEGV**；`SecItemCopyMatching failed -50`，未完成构建 |
| `bun run typecheck` | **exit 139 / SIGSEGV**；同一错误，未完成类型检查 |
| `git diff --check`、修复 diff 与原报告/新增测试哈希复核 | 无 whitespace 错误；本轮报告写入后重新核对原文件未变化 |

未运行：全量 bun test、修复构建产物的 `PORT=... bun .output/server/index.mjs` 与 HTTP 请求、完整浏览器/Node 开发入口、真实模型/GPU、外部服务、桌面壳、Windows 系统异常、第三语言编译。实现侧声称的 1482/20/0、typecheck/build 历史结果未当作本轮结果。

独立脚本仅创建于 `/private/tmp`，不读真实 data/secrets；使用模拟 EventSource，没有起网络服务，finally 已断开模拟 live ticker、还原 fetch/preprocess/global stubs。脚本在收尾删除。构建和类型检查进程均已退出；由于 build 失败没有启动 `.output` 服务。唯一新增仓库交付文件为本报告，原有未提交改动全部保留。

## 第 3 轮 · 设置版本号返工与 CR-004 补验

日期：2026-10-13。基线仍为 `0e8c582`，修复仍在未提交工作区。只复审本轮版本号差异、CR-004 的补充证据及相邻调用链。前两轮内容保持原样。

**本轮整体结论：rework required。** CR-002 原有四种场景已经修复，但新版本协议在时钟回退后的服务重启场景存在已复现的可靠性问题；CR-004 的补验足以关闭。

| 编号 | 第 3 轮最终判定 |
| --- | --- |
| CR-001 | 已关闭，沿用第 2 轮；本轮未改变该修复路径 |
| CR-002 | **原四种触发已关闭；修复引入新问题，仍需返工（major）** |
| CR-003 | 已关闭，沿用第 2 轮 |
| CR-004 | **已关闭**，结合本轮提供的构建入口证据与前轮独立验证 |
| CR-005 | 已关闭，沿用第 2 轮 |
| CR-006 | 已关闭，沿用第 2 轮 |

### CR-002 · 原四种顺序与 save/load 交互复验

本轮独立脚本使用真实 useSettings、真实 useLive 的 snapshot handler、Vue ref 和可控响应 Promise，验证：

1. 原旧 GET 晚于 save/新快照：rev 1 被 rev 2 拒绝，重读 rev 2，doc/语言不回退。
2. 旧 SSE 晚于 save：rev 3 被已应用的 rev 4 拒绝，不再切回中文。
3. 本窗口旧 POST 晚于另一窗口快照：rev 6 被 rev 7 拒绝，保存仍返回 true/提示 Saved，不覆盖 doc/语言，后台发起 GET 获取 rev 7。
4. 三次 GET 都旧于已应用版本：保留 doc，设置当前语言的 settings.loadStale，首次 doc 为 null 时也有明确错误。

新增独立交互复验：过期 save 分支启动的 load 不占用 saving；save 返回时 saving 已清空，可以继续保存。后台 GET 尚未结束时，下一次 save 应用 rev 8；原后台 GET rev 7 到达后被拒绝并重读 rev 8，未覆盖刚保存的 doc/语言。此路径没有未捕获的后台 load 异常，load 内部 catch 负责 loadError。

这些断言全部通过。新增仓库 stale 测试五项也实际通过。当前版本已解决第 2 轮列出的原四种触发，不能再按原理由报告未修。

### CR-002 · 新回归：跨进程 rev 不保证单调，现有页面可拒绝新服务的有效设置

- **位置**：`server/service/context.ts:159`、`:160`；`app/composables/useLocale.ts:16`、`:24`；`app/composables/useLive.ts:44`；`app/composables/useSettings.ts:26`、`:46`。
- **问题**：rev 仅存在 openStore 的闭包中，启动时重新取 Date.now。`max(rev+1,now)` 只保证同一个闭包内单调，不能像 `context.ts:158` 的注释所称保证跨重启单调。客户端 appliedRev 在 EventSource 断开/重连时不重置，也没有服务实例标识。
- **真实触发条件**：页面保持打开，服务器系统时钟校正回退后重启服务，新进程的启动时间/后续 rev 小于浏览器已应用的旧值。这里没有把“正常、时间向前的重启”报成必然失败；正常启动种子大于旧 rev 的情况已另行验证通过。
- **影响**：新进程明明已保存新语言，现有页面仍拒绝新的 GET、POST 和 snapshot，继续显示旧语言；三次 load 报 loadStale。版本号不是持续随时间更新，单纯等待墙上时钟追上也不会使当前 rev 自行追上；需要刷新页面重置客户端，或额外操作使服务端 rev 提升。与“当前设置应反映在已打开页面”冲突。
- **验证**：未改变真实系统时钟，以可控 Date.now 输入执行真实 openStore，并运行真实客户端处理链。旧已应用 rev=1000003；重启输入时钟=900000，保存中文后新 rev=900001。真实 snapshot handler 保留英文；真实 load 对三个最新中文文档均拒绝并显示英文 loadStale。随后将模拟时钟前进到 2000000，`ref.rev()` 仍为 900001，拒绝仍成立。
- **持久化独立对照**：另用临时目录和真实 JsonStore 保存英文、close、同路径重建 store，再保存中文。旧 rev=1000001，新 rev=900001；磁盘已是中文且没有 rev 字段，acceptSettingsRev 拒绝新值。这个实验没有伪造磁盘内容或修改实现，仅替换时钟输入；临时目录与 watcher 均已清理。输出为 `REAL_JSONSTORE_REOPEN_REV_ROLLBACK {"old":1000001,"reopened":900001,"persistedLocale":"zh-CN","persistedRev":false}`。
- **建议方向**：使用可跨进程恢复的单调 revision；或明确服务实例身份，并在确认新连接/新实例后切换版本域，同时阻止上一实例的迟到响应。不能仅用 Date.now 种子声称跨重启排序已经成立。应补覆盖“保留客户端、重建服务端、时钟回退”的用例。

新增 `tests/core/store.test.ts:210` 的测试验证单个 ref 的 update/refresh 递增及 LiveHub 数字相等；`:229` 只断言种子接近现在，没有执行重启，因此不能证明跨重启保证。这是同一语言一致性发现的修复回归，继续使用 CR-002，不新增编号。

### 其余指定回归边界

- **其他 openStore 使用者**：models、secrets、upstreams 仍使用原 get/update/refresh/回调，新增 rev 方法是附加字段；调用链中没有将这些 store 的 rev 当作 settingsRev。未发现行为回归。refresh 即使内容没变也 bump，会使设置相关快照多一次版本变化，但未发现实质正确性问题。
- **数据与 rev 配对**：openStore 在 value 更新后 bump、再通知。snapshot 在同一同步调用读取 `getSettings().ui.locale` 与 `settingsRef.rev()`（`context.ts:407`、`:408`）；describeSettings 同步取得 settings 并读取 getSettingsRev（`settings-api.ts:25`、`:30`），中间没有 await。未发现新旧文档/版本被异步交错配对的路径。独立 openStore 探测的 update、refresh、watcher 回调均递增，LiveHub snapshot 返回相同 ref 的版本。
- **失败保存/手改**：相关 store 用例验证失败保存仍显示已读取的合法手改值，以及坏手改不会被覆盖，均通过。本轮完整 watcher 用例在沙箱内未收到事件而失败，不能把真实文件监视重载验收称作通过；watcher 版本递增另以回调驱动做了内存验证。
- **缺 rev 的兼容**：acceptSettingsRev(undefined) 接受且不降低已有 appliedRev；首次旧快照/旧设置文档可读，独立验证通过。这是一种无版本兼容模式，不能保证无版本副本与有版本副本混用时的严格排序；当前新服务正常输出两个版本字段，未将这一兼容限制单列为新缺陷。
- **首次加载/页面刷新**：模块新建时 appliedRev=0，首次合法 GET 可应用；独立 reset 对照后低版本可应用。页面完整刷新会重新载入模块，因此可绕过上述跨进程问题；EventSource 普通重连没有这个效果。已有页面的正常、时间向前重启也已通过对照。
- **快照其他字段**：useLive 先更新 state/连接信息，再对 locale 作 rev 校验；本轮排序防护针对设置文档与语言，不把 settingsRev 当作模型、日志等其他数据的统一版本。本轮未发现由此新增的具体错误调用点。

### CR-004 · 补验足以关闭，证据归属明确

本轮用户提供的编排侧实测为：build exit 0；隔离 LLAMA_WEB_DATA、PORT 启动真正 `.output/server/index.mjs`；malformed 名称返回 404 JSON model_not_found，非法 JSON 返回 400 JSON invalid_json；声明 Content-Length 500 后中途断开 body，日志出现 `internal error -:-: The connection was closed.`，客户端无异常原文，最后进程/端口已清理。

该证据覆盖第 2 轮缺失的构建原生入口，且与本轮源码吻合：`server/entry.ts:38` 直接调用 handleV1；`proxy.ts:604` safeDecode 处理 malformed 名称，`:624` 返回 invalid_json，`:545` 的 internal-error 事件正好对应提供的诊断日志，`:546` 返回通用 JSON。第 2 轮已独立触发未断开的 Request body stream 错误，验证该 catch 的 500 JSON 和异常不泄漏。

中途断开的客户端本身无法证明“完整收到 500 JSON”，本轮不作这个断言；日志证明正式入口进入了预期 catch，结合前轮独立的响应验证足以关闭原文案/错误页缺陷。已开始的流式 body 失败不会重新发送 500 JSON，前轮判定保持。

**这是接受用户提供的编排侧入口证据，不是声称 Codex 本轮亲自看到 HTTP 输出。** 本轮独立再次执行 build，仍因 `SecItemCopyMatching failed -50`、SIGSEGV 以 exit 139 退出，未在沙箱外复跑，也没有启动旧 `.output` 冒充当前产物。本轮闭环未要求全量独立测试必须重复成功；用户的全量 1486/20/0 与 typecheck/build exit 0 均保留为编排侧结果。

### 第 3 轮实际命令与结果

| 命令 | 本轮结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、`git diff HEAD --stat`、指定文件 `git diff HEAD`；相关 `cat`/`sed`/`rg`/`nl` | 定位未提交版本号返工与调用链；未重审其他阶段 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/store.test.ts tests/core/i18n-parity.test.ts` | **24 pass / 1 fail**，exit 1；失败为原 watcher 用例未收到文件监视事件；新 rev 用例通过，parity 1841/1841 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/i18n-parity.test.ts` | **8 pass / 0 fail**，exit 0 |
| `bun test tests/core/store.test.ts --test-name-pattern 'context openStore\|update starts from a hand edit\|refresh / update refuse\|a hand edit picked up by refresh'` | **5 pass / 0 fail / 12 filtered out**，exit 0；包含新 rev 和相邻失败路径 |
| `bun /private/tmp/stage11-r3-probe.ts` | 两次均 exit 0；最终版增加真实 JsonStore 重建对照。原四场景、save/load、legacy、首次/reset、单实例 rev 对照通过；时钟回退跨实例回归按预期复现 |
| `bun run build` | **exit 139 / SIGSEGV**，上述 SecItemCopyMatching 环境错误；构建 HTTP 实测本轮未独立运行 |
| `git diff --check`、修复 diff SHA-256 与报告前文前缀校验 | 无 whitespace 错误；修复差异保持不变，报告前两轮字节保持不变 |

本轮未运行：全量 bun test、typecheck、修复产物 HTTP、浏览器/桌面/GPU、真实时钟调整或真实服务重启。跨重启回归证据为控制时钟输入、真实 openStore/JsonStore 重建及真实客户端逻辑，不冒充整机实验。

只追加本节。临时探测脚本和 JsonStore 数据目录已删除，模拟 live ticker 已关闭，Date.now/global stubs 已还原；没有启动 HTTP 服务，构建进程已退出，无本轮服务进程或端口残留。保留所有原有未提交文件，包括非本轮范围的审查报告；没有提交、切分支或修改实现/测试/计划/交接。

收尾 `git status` 还显示新出现的 untracked `.claude/`（起点没有）；本轮没有创建该目录，归属未知，未读取或删除。tracked 修复差异的 SHA-256 与追加前相同，原报告前文 SHA-256 也相同。

## 第 4 轮 · boot 版本域复审

日期：2026-10-13。基线仍为 `0e8c582`，只审查未提交的 boot 接线和相邻客户端行为；前三轮内容保持原样。**整体结论：rework required。** 第 3 轮已识别旧进程的时钟回退场景已修复，但首次加载时未见过的旧 boot 仍可误退役当前服务，继续沿用 CR-002。

| CR | 第 4 轮最终判定 |
| --- | --- |
| CR-001 | 维持已关闭 |
| CR-002 | **第 3 轮具体触发已修；新版本域判定仍存在 major 问题，未完全关闭** |
| CR-003 | 维持已关闭 |
| CR-004 | 维持已关闭，沿用第 3 轮的构建入口证据判定 |
| CR-005 | 维持已关闭 |
| CR-006 | 维持已关闭 |

### 第 3 轮问题的原条件：已经修复

独立探测使用真实 JsonStore/openStore，在临时目录保存英文并重建 store，同时控制 Date.now 从 1000000 回退到 900000。两个 settings ref 的 boot 不同；旧 rev=1000001，新 rev=900001。先让真实 useLive snapshot handler 接受旧 boot，再送入新 boot 的中文 snapshot，并通过真实 useSettings 读取该新 boot 文档：中文成功应用，loadError 为空。随后更高 rev 的旧 boot snapshot 被拒绝。

这与第 3 轮的失败输入相同，故不再按“已认识的旧 boot 阻止重启后低 rev”报告缺陷。新增两个客户端用例本轮实际通过。服务端 GET（`server/service/settings-api.ts:31`）和 snapshot（`server/service/context.ts:416`）都从同一个 settingsRef 取 boot，update/refresh/watcher 不改变它；虽然 UUID 实际按 openStore 实例生成，当前每个 AppContext 只有一个 settingsRef，未发现不同设置通道生成不同 boot 的问题。

### CR-002 · 仍需返工：未知 boot 不等于更新的进程

- **严重度**：major。
- **位置**：`app/composables/useLocale.ts:28`～`:32`；调用点 `app/composables/useSettings.ts:26`、`:46`，`app/composables/useLive.ts:44`。
- **问题**：任何不同且不在 retiredBoots 的 boot 都被视为更新实例，当前 appliedBoot 随即退役。UUID 只识别实例，不携带先后关系；集合只能拒绝页面曾见过的旧实例，不能拒绝尚未见过的旧实例副本。
- **真实可发生的输入顺序**：页面首次打开/刷新后 appliedBoot 为空；它向进程 A 发出设置 GET，A 生成响应但暂未送达。服务重启到 B，EventSource 的 B snapshot 先到，页面首次认识 B。随后旧 GET 的 A 响应到达；页面从未认识过 A，因此把 A 当成新实例，退役 B并应用旧语言。后续来自实际服务 B 的有效 GET/POST/snapshot 都被 retiredBoots 拒绝。这里不要求同一 SSE 连接内帧乱序，只要求独立 HTTP 与 SSE 通道的送达顺序不同。
- **验证**：独立脚本调用真实 useSettings 和真实 useLive snapshot handler，重置初始状态，启动 pending GET，先投递 `{settingsRev:1,settingsBoot:'new-b',locale:'en'}`，再完成旧 GET `{rev:100,boot:'old-a',ui:{locale:'zh-CN'}}`。GET 被接受，doc.boot 变为 old-a、语言中文；随后 new-b rev 2 snapshot 仍无法切回英文。对三个当前 new-b GET 完成 load，得到 loadStale。实际输出：`UNSEEN_OLD_BOOT_RETIRES_NEW_BOOT {"ui":"zh-CN","docBoot":"old-a","freshServerBoot":"new-b","loadError":"设置在加载期间被其他页面修改了，请刷新重试。"}`。boot 名称为内存测试标识，未修改真实系统或实现；未在浏览器/整机重启下实测。
- **影响**：最新服务被误判为已退役；正常的新快照无法自愈，只有刷新页面或再次切换版本域才能恢复。与第 3 轮的客户端拒绝当前设置结果相同，但原因已变为 boot 先后识别。
- **建议方向**：服务实例切换应由可确认的当前连接/握手，或请求发起时的会话代次约束，不应由任意迟到副本宣布切换并永久退役当前实例。补“页面尚未见过 A、B snapshot 先到、A GET 后到”的测试。仅增加 retiredBoots 的容量不能修复。

新增仓库用例先显式接受 boot-a、再接受 boot-b，覆盖的是已认识旧实例的重启。它们没有覆盖上述首次加载顺序；用例通过不等于任意旧实例迟到都已安全。

### 指定兼容与回归边界

- **页面刷新/首次加载**：刷新会重建模块，清空 appliedRev/appliedBoot/retiredBoots。新 B snapshot 先到、随后同 B 的 GET 到达，独立复验通过；旧 A 曾被接受时，B snapshot 先于 A 的迟到 GET，也能正确拒绝 A。只有上述“旧 A 未被见过”顺序失败，不能笼统报告所有 snapshot 先于 GET 都失败。
- **多窗口**：状态只在当前页面模块中共享，没有 localStorage/广播写入，不同窗口各自排序；同一服务 settingsRef.boot 相同，不会因别的窗口保存而产生新 boot。同 boot 的 rev 排序路径未变，第 3 轮的旧 POST/GET/SSE保护保持。上述首次加载问题可以发生在任一窗口，并非跨窗口共享集合引起。
- **退役集合**：真实函数独立连续接受 200 个不同 boot 后，前 199 个更高 rev 副本均被拒绝，当前 boot 能继续更新。集合与页面生命周期绑定、只因实例切换增长；未发现普通保存反复增加集合，也没有按此提出内存泄漏意见。它的限制是未知旧 boot，见 CR-002。
- **有 rev 无 boot 的副本**：确定存在版本域污染。接受 B rev 1 后，一个无 boot 的 legacy rev 100 会直接推进 B 所使用的 appliedRev；后续 B rev 2 被拒绝。真实 handler 内存输出 `REV_WITHOUT_BOOT_POISONS_VERSIONED_DOMAIN zh-CN`。反向顺序“先 legacy rev，再首次带 B boot 的低 rev”会重置并正常接受，已复验。当前新服务正常响应都带 boot，所以没有声称同版服务会自行产生无 boot 文档；这是兼容版本副本混用时的确定行为。兼容分支若继续接受缺 boot 副本，应避免将无法归属实例的 rev 写入已知 boot 的版本域。
- **无 rev 的副本**：入口首先 return true，即使带已退役 boot 也接受。这符合本轮明确给定的兼容约定，不单列为新缺陷；该模式不能提供跨版本排序保证。
- **服务端 store 接线**：settings boot 的 GET/snapshot来源一致，新方法为 openStore 附加字段，其他 stores 没有把它当作 settingsBoot。新增 ref.boot 不同的测试本轮通过。未发现额外配置写入、迁移或密钥处理变化。

### 第 4 轮实际验证与收尾

| 命令 | 结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、指定文件 `git diff HEAD`；相关 `sed`/`nl`/`rg` | 确认本轮 boot 差异与调用链，没有重审其他阶段 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/i18n-parity.test.ts` | **10 pass / 0 fail**，exit 0；包含本轮两个 boot 用例，parity 1841/1841 |
| `bun test tests/core/store.test.ts --test-name-pattern 'context openStore\|update starts from a hand edit\|refresh / update refuse\|a hand edit picked up by refresh'` | **5 pass / 0 fail / 12 filtered out**，exit 0；包含本轮 ref.boot 不同的断言 |
| `bun /private/tmp/stage11-r4-probe.ts` | exit 0，全部独立断言完成：真实 JsonStore重建/时钟回退原问题关闭；正常 snapshot→GET、已认识旧 boot 晚到、legacy 首次过渡及退役集合通过；未知旧 boot 误退役当前 boot、rev-only 污染版本域按预期复现 |
| `git diff --check`、tracked 修复差异 SHA-256、报告前文前缀 SHA-256 | 无 whitespace 错误；本轮只追加报告，修复文件与前三轮前文字节保持不变 |

没有独立运行全量 bun test、typecheck、build、HTTP、浏览器/桌面/真实服务重启。用户提供的编排侧 **1488 pass / 20 skip / 0 fail、typecheck exit 0** 明确为外部验证结果，不作为 Codex 自行复跑记录。此轮不重新打开已关闭的 CR-001/003/004/005/006。

临时脚本、JsonStore 数据目录已删除，store/watcher、模拟 live ticker 均清理，Date.now/global stubs 已还原；本轮未起网络服务或长期进程。只追加本节，没有提交、切分支或修改实现/测试/计划/交接，原有 `.claude/` 及其他 untracked 文件保留。

## 第 5 轮 · 持久化启动序号复审

日期：2026-10-13。基线仍为 `0e8c582`，范围限于新增 boot-seq、整数 boot/rev 接线及其恢复边界；前文保持原样。**整体结论：rework required。** 第 4 轮两个具体问题在正常持久化路径下均已关闭；但启动序号写入失败后仍公布编号，会在下一次启动重用已公布的 boot，继续沿用 CR-002。

| CR | 第 5 轮最终判定 |
| --- | --- |
| CR-001 | 维持已关闭 |
| CR-002 | **原两个触发已修；新持久化失败路径存在 major 回归，未完全关闭** |
| CR-003 | 维持已关闭 |
| CR-004 | 维持已关闭，沿用第 3 轮证据 |
| CR-005 | 维持已关闭 |
| CR-006 | 维持已关闭 |

### 第 4 轮两个原触发：已经修复

使用真实 useSettings、真实 useLive snapshot handler 与可控响应，首次接受 boot 8 的英文快照，再完成未见过的 boot 7/rev 100 旧中文 GET：旧 GET 被丢弃，重读 boot 8 成功，其后 boot 8/rev 2 仍可更新语言。UUID 的“未知旧 boot 退役当前 boot”问题已消失。

接受 `(boot=8,rev=2)` 后，缺 boot 的 rev 100 副本按兼容约定暂时应用，但没有推进已记住的版本；随后完整的 `(8,3)` 正常应用，未被旧协议锁住。缺 rev 同样不改变比较基准。这里是明确约定的无版本兼容，不宣称无版本副本自身可以被严格排序。

仓库 stale 测试八项、boot-seq 测试三项及 parity 三项本轮通过。正常文件情况下，boot 在同一数据目录按 1、2、3 递增，无论时钟如何变化；新 boot 可接受 rev=0，旧 boot 即使 rev 更大也被拒绝。这些路径不再按旧理由报告缺陷。

### CR-002 · 新回归：写入失败仍公布 boot，随后重用编号

- **严重度**：major。
- **位置**：`server/core/boot-seq.ts:33`～`:37`；调用点 `server/service/context.ts:277`；拒绝新副本的位置 `app/composables/useLocale.ts:28`。
- **问题**：nextBootSeq 捕获原子写失败、仅警告，然后照常 return next；context 随即对外使用该编号。这意味着已公布的版本域不一定保留在磁盘。下次启动从未更新的旧文件重新加一，可能取得与前进程相同的 boot，而 rev 已归零。
- **触发条件**：数据目录锁已取得后，写 boot.json 遇到 I/O 错误，程序继续启动并被页面看到；后续错误解除、服务重启，旧 boot 文件仍保留原序号。可能对应磁盘写入/替换失败、文件占用或锁取得后的权限变化。没有声称“启动前整个 run 目录只读”也能取得锁；那种情况会更早被数据锁拦住。
- **验证**：在任务临时目录中，真实 boot.json 为 `{version:1,seq:7}`，先用真实 acquireDataLock 取得锁，再暂时把该临时 run 目录设为不可写。真实 nextBootSeq 发出 cannot write 警告但返回 8，磁盘仍为 7；还原权限并释放锁。再次取得同一目录锁并正常执行 nextBootSeq，也返回 8，此时磁盘成功写为 8。两次严格串行，故数据锁不能补偿这个持久化失败。
- **客户端结果**：真实 snapshot handler 先接受失败写入进程的英文 `(8,5)`，再接收下一进程中文 `(8,0)`，保留英文；真实 useSettings 对三个当前 `(8,0)` 文档重读均拒绝，显示英文 loadStale。输出为 `WRITE_FAILURE_REUSES_PUBLISHED_BOOT {"oldBoot":8,"newBoot":8,"disk":8,"ui":"en","error":"The settings were changed by another page while loading. Refresh and try again."}`。
- **影响**：新进程被当作旧副本，语言/设置视图保持旧值，直到新 rev 超过已记住的旧 rev，或页面刷新。正常的重连无法保证恢复。探测只改变临时目录权限，不改实现或真实数据，所有权限/锁均已还原。
- **建议方向**：持久化成功后才能对外公布可排序的 boot；无法建立该保证时应明确阻止启动或采用明确的恢复协议，不能只警告然后继续提供同一排序保证。补一次“boot 写入失败→继续使用→下次启动→保留客户端”的回归用例。无需修改随机 boot/retiredBoots 的旧方案。

### 损坏兜底的排序含义

`boot-seq.ts:29` 的 Date.now 兜底在旧计数仍很小、时钟合理且成功持久化时，通常大于既有启动次数；此后完整文件继续按 +1 递增，独立验证通过。它**不是可证明的旧序号上界**。序号曾通过兜底升到时间戳量级后，文件再次损坏且时钟回退，就可能发出更小 boot。

独立对照：损坏文件按注入时钟 1700000000000 恢复，下一次即使时钟输入为 1 也取得 1700000000001；再次构造损坏并给回退时钟 1600000000000，返回该更低 boot，真实 acceptSettingsRev 拒绝它。没有调整真实系统时钟或声称现实中已经发生这组复合故障。结论是“损坏后的恢复只提供条件性排序”，不能将正常文件下的时钟无关性扩写到这个兜底路径。

删除/丢失文件直接从 1 起也会丢失与旧客户端的顺序关系。用户显式选择这一恢复策略，但旧页面若保持打开仍需刷新或另有版本域恢复机制；报告不把首次安装缺文件当成缺陷。

### 数据锁、桌面目录、临时目录、多窗口与首次加载

- **锁顺序正确**：context 在 `:241` 取得 dataLock，才进入 createOwnedContext 并于 `:277` 分配启动序号；失败启动会释放锁。独立对照在持锁时再次 acquire 被拒，释放后可继续分配，正常 boot 从 1 到 2。没有发现两个正常启动并发 read-increment-write 的入口。
- **配置接线一致**：rev 从 0 起，openStore 的 update/refresh/watcher 分支各递增，不读时钟。GET 与 snapshot 使用同一个 context settingsBoot；其他 store 不分配额外启动号，SettingsDoc 的元数据不写入 settings.json。没有 schema 迁移副作用。
- **桌面数据目录**：桌面子进程通过 `src-tauri/src/main.rs:417` 的 LLAMA_WEB_DATA 指定目录，context 使用 resolveDataDir，所以 boot.json 属于实际桌面数据目录，不落到源码目录。桌面离线导入白名单 `desktop/import-data.ts:8` 不复制 run，不会搬入另一个正在运行目录的锁/boot；导入在首次服务启动前进行，见 `src-tauri/src/main.rs:132`～`:139`。未实测桌面壳。
- **不同数据目录**：boot 是每目录序列，不是全机器序列。两个临时目录各自从 1 起，独立验证通过。同 origin 保留旧页面而改用新数据目录时，新目录低 boot 会被旧页面拒绝；完整页面刷新可重置比较基准。桌面通常新建主 Webview（`src-tauri/src/main.rs:332`）而重新加载页面，但外部浏览器保持打开的情况不能由它保证。这是目录版本域的限制，未冒充实际桌面故障。
- **多窗口**：各页面各自保存 `(appliedBoot,appliedRev)`，共用同服务的启动序号；窗口间没有共享客户端版本状态。正常同目录条件下，服务器统一 boot 与每次保存的 rev 足以排序不同窗口的迟到响应；未发现本轮新增的跨窗口竞争。
- **首次加载/刷新**：初始比较基准为 `(-1,-1)`，缺文件首次 boot=1/rev=0 可应用；完整刷新重建模块，也可接入另一个目录的低 boot。没有退役集合增长问题，代码已删除该集合。
- **测试目录**：boot-seq 测试使用 mkdtemp/afterEach 清理；openStore 单元测试本身不调用 nextBootSeq，不会修改实际 data/run/boot.json。本轮探测仅用自建临时目录，没有读取 data/secrets.json。

### 第 5 轮验证记录

| 命令 | 实际结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、指定文件 `git diff HEAD`、读取两个新增文件及相关 `sed`/`rg`/`nl` | 确认正常路径及锁/桌面/恢复接线 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/boot-seq.test.ts tests/core/i18n-parity.test.ts` | **14 pass / 0 fail**，exit 0，parity 1841/1841 |
| `bun test tests/core/store.test.ts --test-name-pattern 'context openStore\|update starts from a hand edit\|refresh / update refuse\|a hand edit picked up by refresh'` | **5 pass / 0 fail / 12 filtered out**，exit 0 |
| `bun /private/tmp/stage11-r5-probe.ts` | exit 0；第 4 轮原两个失败输入关闭；真实锁串行与正常重启通过；原子写失败重用 boot、损坏复合恢复降低 boot 按预期复现；目录隔离和页面重置对照完成 |
| `git diff --check`、修复差异/新增实现与测试哈希、报告前文前缀哈希 | 无 whitespace 错误；前文与实现/测试差异保持不变 |

本轮未独立运行全量 bun test、typecheck、build、HTTP、真实 Windows 文件占用、整机时钟调整或桌面重启。用户给出的 **1492 pass / 20 skip / 0 fail、typecheck exit 0** 保留为编排侧验证结果；不替代本轮结果，也不使未覆盖的持久化故障自动通过。已关闭的其他 CR 不重新审查。

本轮只追加本节。临时脚本及所有自建目录已删除，临时权限、数据锁、模拟 live ticker 和 global stubs 均清理/还原；没有启动网络服务或长期进程，没有提交、切分支或修改实现/测试/计划/交接，原有未提交文件全部保留。

## 第 6 轮 · 无序降级与损坏恢复复审

日期：2026-10-13。基线仍为 `0e8c582`。**整体结论：rework required。** 写入失败后公布/重用 boot 的原触发已经关闭；损坏后的较低基数在下一次启动自动恢复为有序版本，仍有已复现的问题。前五轮保持原样。

| CR | 第 6 轮最终判定 |
| --- | --- |
| CR-001 | 维持已关闭 |
| CR-002 | **写入失败子项已关闭；损坏恢复排序子项仍未完全关闭（major）** |
| CR-003 | 维持已关闭 |
| CR-004 | 维持已关闭 |
| CR-005 | 维持已关闭 |
| CR-006 | 维持已关闭 |

### 已关闭：写失败不再公布不可持久化的编号

`server/core/boot-seq.ts:40`～`:42` 捕获写失败后返回 null，没有再 return 未落盘的整数；`context.ts:414` 在 null 时省略 settingsBoot，`settings-api.ts:31` 在 null 时省略 boot。客户端对缺 boot 的副本直接应用且不更新记住的版本。这项行为符合本轮给定的无版本兼容/降级约定。

独立复验与第 5 轮使用相同的真实文件/数据锁输入：磁盘 boot=7，先取得锁，再使任务临时 run 目录不可写。函数这次返回 null，磁盘仍为 7；恢复权限/释放锁后，下次函数成功返回并持久化 8。客户端先接受原进程 `(7,5)`，再接受失败运行的无 boot 中文副本，最后接受成功运行 `(8,0)` 英文副本，均正常应用，不再将新启动误认为同一 boot 的低 rev。

实际 `describeSettings` 也用构造 AppContext 独立调用：getSettingsBoot 为 null 时结果没有 own property boot，为 8 时结果 boot=8。LiveHub 的构造 snapshot 在 null 条件下同样没有 settingsBoot；没有把 null 或 0 当成可比较的启动编号发出。全程没有创建真实应用 context或读取真实 secrets，构造全局 context 在 finally 中恢复。

未知版本/损坏内容在当前这次运行返回 null，新文件成功写入基数；本次不再把这个未证明有序的基数公布给客户端。相关四个 boot-seq 用例本轮通过。

### CR-002 · 剩余问题：恢复状态仅存在于当前调用，下次自动信任较低基数

- **位置**：`server/core/boot-seq.ts:25`、`:28`～`:29`、`:34`～`:35`、`:39`、`:44`；客户端 `app/composables/useLocale.ts:28`。
- **严重度**：major，继续使用 CR-002 的损坏恢复排序子项。
- **问题**：损坏恢复的 trusted=false 没有持久化。函数写出的 `{version:1,seq:now()}` 与普通可靠计数文件完全相同。下次启动即使这一基数小于曾公布的旧 boot，也会作为正常文件加一并返回整数。当前运行返回 null 只是推迟了失败，并没有建立后续排序保证。
- **条件**：序号曾经过时间戳兜底并在后续启动被公布；之后文件再次损坏，同时恢复时钟回退，页面仍打开。此为复合恢复场景，没有声称普通完整文件、一次正常时钟恢复都会失败。
- **独立复现**：真实 nextBootSeq 首次损坏修复写基数 1700000000000、返回 null；后续完整文件返回已公布 boot=1700000000001，真实客户端记住 `(该boot,9)`。再次损坏，注入回退时钟 1600000000000：修复返回 null，无 boot 副本成功应用，不报错。**再下一次启动，时钟输入已经恢复为 1800000000000**，但函数忽略现在的时钟，从重写的文件返回 boot=1600000000001。
- **结果**：真实 useLive handler 拒绝这个较低整数；真实 useSettings 对三个最新副本均拒绝并显示 loadStale。输出为 `REPAIRED_BASE_NEXT_START_STILL_LOWER {"previousPublished":1700000000001,"repair":null,"nextPublished":1600000000001,"restoredClock":1800000000000,"ui":"zh-CN","error":"设置在加载期间被其他页面修改了，请刷新重试。"}`。控制的是函数已有的 now 参数，不是整机时钟；文件为任务临时文件。
- **影响/建议**：下次看似恢复正常的运行仍无法更新保留页面，直到刷新或启动编号追过旧值。应保留“排序基数不可信”的恢复状态，避免下次仅因 JSON 格式正常就自动公布可信版本；或者明确把这一复合恢复也定为必须刷新页面的产品边界。当前注释说明时钟基数不是证明上界，是准确的风险描述，但不是客户端恢复机制。

这不是重新打开写失败子项，也不是声称 null 被客户端错误拒绝。确切失效点在**后续运行重新公布较低整数**。本轮明确接受的目录切换/删除文件两项边界不自动覆盖该条件；若用户另行接受此复合恢复需要刷新，判定可按改变后的边界收敛，无须继续追求这一场景的无刷新保证。

### 用户已接受的两项边界与其余回归

确认、不反对本轮明确接受的边界：同 origin 的页面跨数据目录切换，以及 boot.json 删除后从 1 起号，均可要求刷新页面。原因是客户端保留的整数属于已丢失的另一排序域，服务端无法仅凭新文件证明它比历史版本新。完整刷新重建 `(-1,-1)` 比较状态，独立 reset 对照后较低整数能够应用；本轮不再将这两项作为需要修复的意见。

其余回归未发现新增问题：读正常/写成功才返回整数；context 在数据锁持有期间只分配一次启动序号；null 运行的 rev 仍进程内递增、但缺 boot 副本不污染已记住的版本；其他 openStore stores 没有参与 boot 分配；GET/snapshot 两种类型都允许缺 boot，没有把可选字段修改成配置迁移；多窗口独立比较状态。无 boot 降级期间缺少严格乱序保护是本轮指定的兼容行为，不再据此提出另一项缺陷。

### 第 6 轮实际验证与收尾

| 命令 | 结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、相关 `git diff HEAD`、`cat`/`nl`/`sed`/`rg` | 确认 number/null 与可选字段差异、真实调用链 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/boot-seq.test.ts tests/core/i18n-parity.test.ts` | **15 pass / 0 fail**，exit 0；包括 chmod 写失败用例；parity 1841/1841 |
| `bun test tests/core/store.test.ts --test-name-pattern 'context openStore\|update starts from a hand edit\|refresh / update refuse\|a hand edit picked up by refresh'` | **5 pass / 0 fail / 12 filtered out**，exit 0 |
| `bun /private/tmp/stage11-r6-probe.ts` | 两次 exit 0；最终版增加真实 describeSettings 的 boot 省略/整数对照。原写失败触发关闭；损坏复合恢复的后续低 boot 拒绝按预期复现；完整页面 reset 恢复对照通过 |
| `git diff --check`、修复差异/新增代码与测试 SHA-256、报告前文前缀校验 | 无 whitespace 错误；实现/测试和报告前五轮保持原样 |

未独立运行全量 bun test、typecheck、build、HTTP、浏览器/桌面重启、Windows 文件占用或真实系统时钟调整。用户提供的 **1493 pass / 20 skip / 0 fail、typecheck exit 0** 属编排侧结果，不写成 Codex 复跑结果。已关闭的其他 CR 不重审。

本轮只追加本节，没有提交、切分支或修改实现/测试/计划/交接。临时脚本、权限变化、数据目录/锁及模拟 ticker、global stubs 已清理/恢复，没有启动网络服务或长期进程；所有原有未提交文件保留。

## 第 7 轮 · 去除时钟依赖与重置边界复审

日期：2026-10-13。基线仍为 `0e8c582`。**整体结论：pass。** 本轮明确将损坏/未知版本/非法 seq 的重置纳入与缺失文件相同的“旧页面需刷新”边界；按这一已调整的约定，CR-002 剩余项关闭。前六轮保持原样。

| CR | 第 7 轮最终判定 |
| --- | --- |
| CR-001 | 维持已关闭 |
| CR-002 | **已关闭（包含用户明确接受的重置后刷新边界）** |
| CR-003 | 维持已关闭 |
| CR-004 | 维持已关闭 |
| CR-005 | 维持已关闭 |
| CR-006 | 维持已关闭 |

### CR-002 · 时钟依赖消除，损坏恢复归入明确的重置边界

- **位置**：`server/core/boot-seq.ts:17`、`:21`、`:23`～`:37`；调用点 `server/service/context.ts:277`；客户端比较/刷新对照 `app/composables/useLocale.ts:26`～`:35`。
- **判定依据**：函数签名只剩 dataDir、warn，没有 now 参数；正常文件仅以 seq+1 编号，缺失或非法内容均从 1 起，原子写成功才 return 整数。没有 Date.now 基数或“本次降级、下次自动信任时间戳”的路径。context 的 rev 仍从 0 起，在 update/refresh/watcher 中递增；现有 Date.now 用于系统信息缓存、live 时间显示，不参与 boot/rev 排序。
- **原触发条件复核**：第 6 轮的“再次损坏 + 时钟回退 + 后续启动公布较低 boot”不再走时钟兜底。损坏会直接重写 `{version:1,seq:1}`，随后从 2 起正常递增。保留页面的较大旧 boot 仍会拒绝重置后的整数，这一点没有被隐藏，也没有声称无需刷新即可恢复；用户本轮明确接受它，注释与损坏警告均说明需要刷新。
- **独立验证**：临时将 Date.now 替换为抛异常的函数，真实 nextBootSeq 在真实临时文件上仍完成正常 1/2/3 递增，以及非法 JSON、null、缺字段、未知版本、负数、小数、字符串 seq 七种重置；每种都落盘 `{version:1,seq:1}`，后续返回 2。因而正常和恢复分支都没有读取 Date.now，没有调整整机时钟。
- **边界验证**：真实 acceptSettingsRev 先记住第 6 轮旧值 `(1700000000001,9)`，对损坏重置后的 `(1,0)` 和下一次 `(2,0)` 均拒绝。以 resetSettingsRev 模拟完整刷新重建模块状态后，`(2,0)`、`(2,1)` 可接受，同 boot 旧 rev 仍拒绝。此为内存刷新对照，未实际操作浏览器。
- **严重度/后续**：原 major 子项按本轮明确调整后的契约关闭，不新增意见。跨数据目录、文件删除、损坏或非法内容后重置启动序列，仍可能要求保留页面完整刷新；不反对这条已接受边界。

### 写入失败与相邻回归

未发现新增问题。`server/core/boot-seq.ts:32`～`:35` 保留“写入失败返回 null、成功持久化才公布”的第 6 轮修复。独立真实文件探测：正常文件 seq=7，临时 run 目录设为 0500 后返回 null、磁盘仍是 7；恢复权限后首次返回 8 并落盘，没有重用已经公布的号。另一对照先构造损坏文件，再令修复写入失败：返回 null、磁盘保留原损坏内容；恢复权限后才返回并持久化 1。两条路径均发出 cannot write 警告。

调用链仍一致：context 在数据锁持有期间只分配一次 boot；`server/service/context.ts:414`、`server/service/settings-api.ts:31` 在 null 时省略 boot 元数据，客户端 `useLocale.ts:27` 对缺完整版本的副本应用但不修改比较基准。两个无 boot/无 rev 兼容输入、正常重启低 rev、旧 boot GET 晚于新 snapshot、旧 GET/POST/SSE 与三次重读耗尽均由本轮相关测试通过。无版本降级仍缺少严格乱序保护，属于此前已接受的兼容行为。

首次加载及完整刷新从 `(-1,-1)` 接受新启动号；多个窗口各自比较同服务的 `(boot,rev)`，本轮没有改变客户端比较逻辑。其他 openStore stores、桌面数据目录与导入/数据锁接线未改；本轮只读复核接线，没有重新实测桌面壳或跨目录运行。已关闭的 CR-001/003/004/005/006 不在本轮变更路径中，维持之前结论，未重新运行其完整原场景。

### 第 7 轮实际验证与收尾

| 命令 | 结果 |
| --- | --- |
| `git status --short`、`git log -1 --oneline`、相关 `git diff HEAD`、`cat`/`nl`/`sed`/`rg` | HEAD 为 0e8c582；确认未提交修复与实际调用链；nextBootSeq 无 now 参数、无 Date.now 依赖 |
| `bun test tests/app/use-settings-stale.test.ts tests/core/boot-seq.test.ts tests/core/i18n-parity.test.ts` | **14 pass / 0 fail**，exit 0；parity 1841/1841；本机非 root，chmod 写失败断言实际执行 |
| `bun test tests/core/store.test.ts --test-name-pattern 'context openStore\|update starts from a hand edit\|refresh / update refuse\|a hand edit picked up by refresh'` | **5 pass / 0 fail / 12 filtered out**，exit 0 |
| `bun /private/tmp/stage11-r7-probe.ts` | exit 0；`CLOCK_DISABLED_NORMAL_AND_RESET`、`FAILED_WRITE_NOT_PUBLISHED`、`RESET_BOUNDARY_REFRESH` 三组断言通过；正常递增、七种非法内容、两种写失败及刷新对照均完成 |
| `git diff --check`、`git diff HEAD --binary` 与新增实现/测试 SHA-256、报告前文前缀 SHA-256 校验 | 无 whitespace 错误；实现/测试未被本轮修改；前六轮字节保持不变 |

本轮独立复跑合计 **19 pass / 0 fail**。全量 bun test、typecheck、build、HTTP、真实浏览器/桌面刷新、Windows 文件占用及系统时钟调整均**未运行**；本轮集中验证 boot-seq 恢复差异及相邻版本路径。用户提供的 **1492 pass / 20 skip / 0 fail、typecheck exit 0** 属编排侧结果，不写成本轮独立复跑。

本轮仅追加本节。临时脚本与自建数据目录已删除，临时权限、Date.now 和内存比较状态已恢复；没有启动网络服务或长期进程，没有提交、切分支或修改实现/测试/计划/交接。全部既有未提交文件保留。
