# 阶段 11 · 多语言界面交叉审查

日期：2026-10-09。结论：**rework required**。发现 2 项 major、4 项 minor；没有修改实现、计划或交接，没有切换分支、提交或推送。唯一新增仓库文件是本报告。

## 范围与证据

已读 router、AGENTS.md、决定 18、阶段 11 全部任务及验收标准、claude-guide 的会话规则/收尾/审查说明，以及 handoff 顶部的 11-4、各批译文、11-2、11-1 交接。交接中“尚未提交”的描述已过时，以 Git 历史为准。

用 `git log` 定位的实现提交：

| 提交 | 范围 |
| --- | --- |
| `4712bb3` | 11-1：字典、服务端 locale、settings v11、迁移和测试 |
| `3fce7f4` | 11-2：useLocale、前端接线、profile-label、桌面初始语言 |
| `f080f11` | 11-2..11-4：译文、parity 硬失败、格式化、proxy 三处修改 |
| `8f1f2b6` | 语言入口移到侧栏 |

以 `git show <提交> -- <文件>` 阅读阶段差异，以 `git show HEAD:<文件>` 阅读调用链和当前行号。当前核验基线：`0e8c58296fede93c87b408c11f55138d86799b05`。后续阶段 10 修复 `5da4353` 也纳入现状核验；**不重复报告 forwardExternal 的 key 遮挡问题**。实现者为交接中记录的 Claude/母 AI；本次为 Codex 独立只读审查，没有派发其他审查代理。

## 审查意见

### CR-001 · major · `/v1/*` 合成错误仍原样插入异常文本

- **位置**：`server/core/proxy.ts:302`、`:571`、`:582`、`:584`、`:644`。
- **问题**：`upstreamUnreachable`、`preprocessFailed`、`externalUnreachable` 的 `{detail}` 仍来自异常原文。模板切换语言并不翻译或清理 detail，异常携带的路径、内部诊断或旧语言会直接成为第三方客户端读取的 message。外部分支遮挡 key 已修，但这不等于其他诊断也被消除。这些是 llama-web 自己合成的响应，不是上游 body 的透传。
- **触发条件**：本地上游 fetch 失败、预处理抛出异常，或外部 fetch 失败且其 detail 含内部诊断/非当前语言。普通 fetch 失败也会把运行时的英文解释拼进中文模板。路径泄漏是否发生取决于实际异常内容。
- **验证**：内存调用真实 `createProxy().handleV1()`，设置 `setLocale('en')`；以构造的 fetch 异常 `Error('诊断: X:\\private\\runtime\\llama-server.exe')` 注入本地转发，得到 502 `upstream_unreachable`，message 同时包含英文模板、中文诊断、完整占位路径。临时替换内存中的 `DEFAULT_STEPS[0]` 为抛出构造异常的步骤，得到 500 `preprocess_failed`，同样原样带出路径；随后恢复 fetch 和步骤。外部分支仅静态追踪，未注入实际上游故障。没有读取真实模型目录或密钥。
- **建议**：第三方 API 返回当前语言的稳定错误；原始 detail 留给服务端诊断。若确实要公开诊断，应先明确哪些内容允许公开并做白名单处理。不能仅凭外层模板走 i18n 就称所有出口已关闭。
- **处理（2026-10-13）**：已修复。`/v1` 合成错误删除 `{detail}`（中英各 3 个键），原始异常经 `onEvent` 留服务端日志；外部分支仍先 `redactText` 遮挡 key。修复复审（stage-11-fixes-codex.md）第 2 轮判关闭。

### CR-002 · major · 旧 HTTP 响应能覆盖新语言快照

- **位置**：`app/composables/useSettings.ts:19`、`:21`、`:33`、`:35`；`app/composables/useLive.ts:38`、`:43`。
- **问题**：GET、POST 和 SSE 三条通道都无条件应用 locale，没有配置版本或新旧判定。`saving` 只互斥 save，不能阻止之前的 load 返回。旧 GET 晚到后会同时覆盖 `settings-doc` 和界面语言；若英文 snapshot 已经发过，LiveHub 不会仅为了这个客户端的错误状态再发送同一个 snapshot，界面可能一直保持旧语言。
- **触发条件**：设置页 load 的中文响应已生成但延迟送达；用户从侧栏保存英文，新 POST 和英文 SSE 先到，旧 GET 最后到。另一个窗口改语言与旧 POST 的响应乱序也有相同风险。
- **验证**：用 Vue ref 和可控 Promise 桩掉 `useState`、`useToast`、`$fetch`，执行真实 `useSettings().load()`；先完成英文 save，再按真实 snapshot handler 的行为调用 `setUiLocale('en')`，最后完成旧 GET `{ui:{locale:'zh-CN'}}`。实际输出从 `AFTER_SAVE_AND_NEW_SNAPSHOT en` 变成 `AFTER_OLD_GET zh-CN zh-CN`。未运行浏览器网络限速场景。
- **建议**：HTTP 文档与快照共享单调配置版本，并统一判定后再更新 doc/locale。仅对 load 加请求序号不能完整解决跨 HTTP/SSE 的乱序。
- **处理（2026-10-13）**：已修复。按建议改为服务端设置版本 `(boot, rev)`：`boot` 为 `data/run/boot.json` 持久化启动序号（写入成功才公布，缺失/损坏从 1 重新计数），`rev` 进程内单调；GET / POST `/api/settings` 与 live 快照都带版本，客户端 `acceptSettingsRev` 统一丢弃旧副本；重读三次仍过期时显示 `settings.loadStale`。修复复审第 2–7 轮，第 7 轮判关闭。已接受的边界：页面跨数据目录切换、`boot.json` 被删除或损坏后，已打开的旧页面需刷新。

### CR-003 · minor · Node 开发入口仍传出上游 statusText

- **位置**：`server/core/proxy.ts:358`、`:391`；`server/routes/v1/[...path].ts:5`。
- **问题**：11-4 修复了无 body 的冷加载 SSE 错误文案，但普通 forward 返回的 Response 仍带上游 statusText。Bun 的 HTTP writer 对原因短语的规范化，不能覆盖 `nuxt dev` 的 Node/h3 路径；h3 将 Response.statusText 赋给 Node response.statusMessage。
- **触发条件**：使用 Node 开发入口，ready 模型返回自定义 ASCII 原因短语。这里只报告 HTTP 原因短语残留，不把约定的上游 body 透传当作翻译缺陷，也不重复报告密钥泄漏。
- **验证**：本地转发的 fetch 桩返回 `new Response(null,{status:502,statusText:'Upstream Exploded InternalReason'})`，真实 proxy Response 保留该短语；再调用本机安装的 h3 `sendWebResponse`，以响应对象桩捕获到 `statusCode=502`、`statusMessage='Upstream Exploded InternalReason'`。额外读取 `node_modules/h3/dist/index.mjs:956` 确认适配器赋值；这是依赖证据的例外，仓库代码仍用 git show 阅读。未启动完整 nuxt dev，未在真实 Node socket 上复验；不据此断言 Bun 正式入口也暴露原因短语。
- **建议**：proxy 构造 Response 时省略上游 statusText，或使用规范状态短语；不要依赖特定 HTTP writer 兜底。
- **处理（2026-10-13）**：已修复。proxy 两处普通 forward 都不再复制上游 statusText。修复复审第 2 轮判关闭。

### CR-004 · minor · 非 scheduler 异常仍可绕过本地 `/v1` 的 i18n 错误出口

- **位置**：`server/core/proxy.ts:537`、`:539`、`:595`；`server/entry.ts:33`、`:39`。
- **问题**：`handleV1()` 最外层 catch 只记录再 throw，主 Bun listener 没有 error handler。11-4 的通用错误修复只作用于 acquire 失败，无法覆盖 decode、读请求 body 等入口异常。
- **触发条件**：本地入口收到 `GET /v1/models/%ZZ`，`decodeURIComponent` 抛 URIError。公网 handler 有独立的本地化 catch，此处不报告公网同样失守。
- **验证**：以构造配置启动临时 loopback Bun listener，fetch 回调直接调用真实 proxy（与主入口 `/v1` 分支相同），请求上述 URL。默认环境返回 500 HTML 错误页，含 URIError；`NODE_ENV=production` 返回 500 `text/plain`、`Something went wrong!`，而不是当前语言的 OpenAI 错误 JSON。两次探测进程最终 exit 1，错误由故意构造的 URIError 触发；server 在 finally 中停止。没有启动实际应用或使用真实配置。
- **边界**：正式环境探测未在 body 中发现源文件路径；开发 HTML 的原始文本也未匹配到源路径。**不将内部路径泄漏写成这项实测事实**。完整构建产物中的最终表现待确认，需要打包入口 HTTP 复验。
- **建议**：在 `/v1` 边界把未知异常记录后转成 i18n 错误 JSON；非法 URI 可单独返回稳定的 400。
- **处理（2026-10-13）**：已修复。`handleV1` 外层 catch 转成当前语言的 500 JSON（`internal_error`），非法 URI 返回稳定 404。编排侧在构建产物入口（`bun run build` + `.output/server/index.mjs`）实测：`/v1/models/%ZZ` → 404 JSON、非法 JSON → 400 JSON、请求体中途断开只记服务端日志。修复复审第 3 轮判关闭。

### CR-005 · minor · 自定义方案名命中对象原型后被错误映射

- **位置**：`app/utils/profile-label.ts:12`；`i18n/messages.ts:57`。
- **问题**：`map[name] ?? name` 查到了继承属性。合法自定义方案名 `toString`、`valueOf` 等会得到函数，违反返回 string 的契约，也不再显示原名称。中文映射 `{}` 同样受影响。
- **触发条件**：用户创建名为 `toString` 的方案后在选择项、事件或其他使用 profileLabel 的位置显示。`constructor`、`__proto__` 被后端禁止，故不将它们作为真实触发条件。
- **验证**：真实 `validateProfileName('toString')` 通过，`createProfile` 在构造模型中成功建立 own property。内存实测英文 `typeof profileLabel('toString') === 'function'`；常规 `默认` 得到字符串 `Default`。静态确认 `profileItems` 的 value 始终是原 name，因此该缺陷是显示问题，未发现它改变保存或路由值。
- **建议**：只读取映射的 own property，或使用无原型对象/Map；补一个合法原型同名方案的用例。
- **处理（2026-10-13）**：已修复。改用 `Object.hasOwn`，补中英两种语言下 `toString` / `valueOf` 方案名用例。修复复审第 2 轮判关闭。

### CR-006 · minor · 桌面启动窗口语言匹配忽略系统偏好顺序

- **位置**：`desktop/ui/launcher.js:8`、`:9`。
- **问题**：在字典 keys 上 find，再对 wanted 做 includes/some，优先级由字典顺序决定。所有精确匹配还优先于任何主标签匹配，可能选择用户的第二语言而忽略第一语言。
- **触发条件**：`navigator.languages=['en','zh-CN']`、`['en-US','zh-CN']` 或 `['en-US','zh-TW']`；keys 为 prepare 生成的 `['zh-CN','en']`。
- **验证**：只做静态判断与内存执行原选择表达式，包含代码原有的 lowercase 步骤；三组输入都得到 `zh-CN`。没有运行桌面壳或生成 strings.json。
- **建议**：按 navigator.languages 顺序逐个尝试精确匹配/主标签匹配，全部失败才用 packaged default。
- **处理（2026-10-13）**：已修复。`desktop/ui/launcher.js` 按 `navigator.languages` 顺序逐个匹配。修复复审第 2 轮以独立探测判关闭（没有新增仓库测试，未运行桌面壳）。

## 其他重点的核验结果与限制

- **11-4 三处修改**：非 SchedulerError 的 acquire 失败使用 `t.api.internalError`，cancelled 使用 `t.api.cancelled`，无 body 的冷加载 SSE 使用 `t.api.upstreamStreamError`；现有测试三项通过。仍有 CR-001、003、004 的边界。服务端 internal-error 事件接到 `logProxyEvent` 的 logError 分支，实际控制台输出未运行验证。
- **setLocale 与并发**：加载后、store 重载/own update 后、describeSettings 时均应用保存的 locale。`changed()` 调用的 notify 用定时器合并快照，因此不会在同步 applyLocale 前执行快照推送。已有请求在 await 后构造新错误时读取当时的全局语言；这符合“保存即切换”，计划没有规定请求必须固定开始时语言。未发现现有 proxy 文案组合中跨 await 缓存字典分支导致混用的路径。服务端 Proxy 只代理顶层，缓存 `const api=t.api` 本身不会跨切换更新，但本次未发现相关持久缓存调用点，不能据此报告现有故障。
- **事件排队**：常规 activity 以 kind/code/数据保存，客户端 `eventText` 在渲染时翻译，所以排队或历史事件不因固定模板而滞留旧语言。**待确认**：`server/core/live.ts:121` 对未知错误保存原 message，`useFormat.ts:39` 未知 reason 原样显示；构造中文未知异常后切英文，事件显示英文模板加中文原因。已验证保留原文机制，尚缺实际可达的中文未知异常场景及“诊断原文是否允许保留”的产品边界，故不单列为确定缺陷。持久日志/上游输出不应自动重译。
- **迁移与保存校验**：缺 ui 补中文、已有 en 保留、非法 locale 回落、v12 拒绝、错误 ui 类型拒绝，以及 patch locale 白名单均未发现新问题。迁移写回调用 save，先备份后原子替换；默认保留 20 份。store 的迁移备份、备份保留、拒绝新版本不覆盖文件等测试通过；完整应用重载串联只做静态核验。
- **前端 Proxy/computed**：对象分支别名跨切换有效，Vue computed 内存复现从 `This machine` 更新为 `本机`。数组仍是值，若在 setup 中缓存数组会失效；此次顶层 AST 筛查加调用点阅读未发现此类文案遗漏。唯一筛出的静态文字初始化是 PublicWizard 的可编辑 keyName 默认值，属于将来保存的数据，未要求随切换覆盖用户输入。未发现应报告的 setup 一次求值标签遗漏。
- **首帧**：初值为中文，layout mounted 后连接 SSE；英文配置快照到达后切换。这是交接明确记录的行为，且计划默认语言为中文，未发现硬性契约违背。英文用户可观察到短暂中文，实际闪动时长未运行验证。
- **英文布局**：只做代码判断。已查看侧栏、设置页、模型/方案表单、RuntimeAddModal 和桌面样式；存在 wrap/truncate 等处理，但没有浏览器尺寸证据。未发现可仅凭代码确认的文本溢出缺陷；实际窄屏/长英文页面布局待确认。
- **parity**：当前 `TRANSLATION_DONE=true`，非环境变量，不存在运行时配置绕过；第二个 test 不受此开关控制。第三个 test 的缺键断言仍有 `if (!TRANSLATION_DONE) return`，手动把常量改 false 会恢复缺键 warn-only，但当前已提交状态不会这样运行。测试直接比较 enSkeleton，fallback 不能掩盖缺键。七种克隆字典负向注入分别检测到缺键、占位符、数组长度、数组对象字段、中文、空串、invented 键。当前输出 **1840/1840 complete**；比交接 1835 多的键来自后续提交，不是测试漏报。
- **数据不变**：除 CR-005，未发现 `默认`→Default 显示映射修改保存/路由值。模型名称、请求记录数据没有因切换被改写；useChat model option value 使用原 profile，profileItems 同样保留 value。用户创建的新会话标题/新方案复制名可以取创建时语言，一旦成为数据不要求重新翻译。
- **桌面生成链**：prepare 从 LOCALES/dictionaries.desktop 生成 `{default,by}`；launcher 只选显示字典，不写 settings。生成产物与真实启动窗口未运行验证。
- **扩展第三语言验收**：静态看，除了 LOCALES 和文件，还需注册 dictionaries、LOCALE_NAMES、LOCALE_SHORT_NAMES、DISPLAY_LABELS，parity 当前也只检查 en。因此“只加一行语言表与一个文件”不能按字面视为已满足；两种现有语言不受影响。未添加第三语言或运行该场景 typecheck。

## 实际运行的命令与结果

源码读取命令按用途归组；所有仓库实现代码由 Git 读取，未 checkout。

| 命令/用途 | 结果 |
| --- | --- |
| `cat` router/common/default/high/cross-review/cleanup/code-review，以及 AGENTS.md；`sed`/`head`/`rg` 读取 plan、guide、handoff | 已读取上述规则和阶段资料 |
| `git status --short`、`git log -18 --oneline`、`git log --all --oneline --grep='i18n\|locale\|11-\|language\|English' -i` | 起点干净；定位四个语言相关实现提交 |
| `git show --stat 4712bb3` / `3fce7f4` / `f080f11` / `8f1f2b6`；上述提交按文件的 `git show`；`git show HEAD:<文件>`、`git grep`、`git ls-tree` | 阅读差异、当前调用链、测试和行号；具体证据位置见各意见 |
| 源码定位失败 | `preprocess.ts`、`start-guard.ts`、`profiles.ts`、`profile-admin.ts` 不是现存路径，git show 报 fatal；修正为 preprocess/index.ts 和 models-admin.ts。一次未加引号的 `[id]` 路径被 zsh 拒绝，随后加引号读取成功 |
| `bun test tests/core/i18n.test.ts tests/core/i18n-parity.test.ts tests/core/settings-admin.test.ts tests/core/store.test.ts tests/app/locale-view.test.ts tests/app/profile-label.test.ts tests/app/use-format-locale.test.ts` | 沙箱内：93 pass / 1 skip / 1 fail，store watch 未收到预期事件；获准在沙箱外同命令复跑：**94 pass / 1 skip / 0 fail**，exit 0 |
| `bun test tests/core/proxy.test.ts tests/core/proxy-external.test.ts tests/core/public-entry.test.ts` | 沙箱内：17 pass / 68 fail，失败为临时端口监听受限 EADDRINUSE；获准沙箱外同命令复跑：**85 pass / 0 fail**，exit 0，约 6 秒 |
| `bun /private/tmp/stage11-review-probe.ts` | 内存探测：alias/computed、旧 GET、构造异常、h3 statusText、profile、launcher 表达式、parity 负向注入、未知事件；最终版 exit 0，结果见上文。初次 parity 提取探测错误使用 TS 默认 ES5 transpile，Map 遍历未执行；改为 ESNext 后七种注入均检测到，不将初次空结果当作通过 |
| `bun /private/tmp/stage11-review-probe.ts --http` | 隔离 loopback，默认 Bun 错误页实测；构造 URIError，最终 exit 1，服务已停止 |
| `NODE_ENV=production bun /private/tmp/stage11-review-probe.ts --http` | 隔离 loopback，production fallback 实测；构造 URIError，最终 exit 1，服务已停止 |
| `sed`/`rg` 阅读安装的 h3 sendWebResponse；`git diff --check`、`git rev-parse HEAD` | 确认 Node 适配器 statusMessage 赋值；diff check 通过；记录核验基线 |

**未运行**：全量 `bun test`、`bun run typecheck`、`bun run build`、完整 nuxt dev/preview、浏览器、GPU/真实模型、真实外部服务、Cloudflare、Windows/macOS 桌面运行、strings.json 生成、真实英文窄屏走查、第三语言扩展编译。此次只运行相关测试；typecheck/build 会生成仓库缓存/构建文件，因此未在本只读审查中运行。交接中的历史通过结果不能替代本轮验证。

临时探测脚本仅放在 `/private/tmp`，用构造数据与内存桩，不读取 data/secrets.json；审查结束删除。临时 listener 在 finally 中停止；测试自身执行清理。报告保留，其他仓库文件不变。

## 处理结果汇总（2026-10-13）

- CR-001 至 CR-006：全部**已修复**，修复复审结论见 [stage-11-fixes-codex.md](stage-11-fixes-codex.md)（7 轮，第 7 轮 pass）。
- 「其他重点」里的待确认项，复审第 1 轮 B 节给出事实判定，2026-10-13 已定：
  - 事件里未知原因原样显示（`live.ts` errorText / `useFormat.ts` reasonText）：没有找到真实可达的中文未知异常调用链，**决定保留诊断原文**（用户交给编排决定，理由见 plan 变更记录 2026-10-13），代码不改。
  - 决定 18「第三种语言只加一行 `LOCALES` 和一个文件」：按现状不成立。实际还要改 import、`LOCALE_SHORT_NAMES`、`LOCALE_NAMES`、`DISPLAY_LABELS`、`dictionaries`，以及 i18n / parity 测试。**用户决定：第三种语言无限期搁置**，只把决定 18 的措辞改为实际注册清单，不补实现。
  - `forwardExternal` 的 secret 遮挡：CR-001 改动后仍成立，无需处理。
- 英文窄屏布局、浏览器实际走查、桌面壳 `strings.json` 实生成：本轮没有运行，留到阶段 11 关口由用户试用。

