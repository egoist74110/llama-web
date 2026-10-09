# 阶段 10 代码审查

日期：2026-10-09。结论：**rework required**。

## 范围与方法

- 审查范围为 `cd7c365^..df5c658`，包含起止提交，重点为 10-1 / 10-1b；涉及进程规则的 10-3 启动器也纳入核查。
- 已读取 AGENTS.md、router 及其审查规则、docs/plan.html 的核心行为规则、关键决定 56、阶段 10 验收标准、会话指南和最新交接。采用 code-review 协议，并参考 backend-security-review 的信任边界检查；权限、明文 secrets 存储等以本项目已确认规则为准。
- 工作区 HEAD 为 `f66ce82`，已经包含后续阶段。**本文文件和行号均指 `df5c658`，不是当前 HEAD**；代码证据通过 `git show df5c658:<path>` 读取，没有切换分支或回退文件。
- 仅新建本报告，不修改实现、计划、交接或测试，不提交、不推送。开始时工作区干净；审查期间出现了其他来源的 `docs/plan.html` 修改，本次未触碰。

`git log --oneline cd7c365^..df5c658` 确认的提交如下（时间顺序）：

| 提交 | 内容 |
| --- | --- |
| cd7c365 | 10-1 / 10-1b 外部上游、前缀路由、独占本机 |
| 039eabd | 公网入口开启时才将其端口视为自身端口 |
| 6e14209 | 独占模式真实进程测试、占用者变化时打印日志 |
| f5f5f2b | 10-2 接入页、本地侧前缀冲突检查 |
| ec7ca6c | 记录图片和公网入口验证 |
| 1e808b4 | 记录隧道和真实独占验证 |
| 76fe03e | 公网入口实际监听时才将其端口视为自身端口 |
| 47fd2ef | 客户端参数保持原样的测试 |
| df5c658 | 10-3 手动启动外部上游并等待模型 |

## 审查意见

### CR-001 · 高 · 上游反射凭据时，响应透传会泄露保存的 key

**位置：** `server/core/proxy.ts:340`、`:354`、`:370`；响应头过滤见同文件 `:250`。

**问题描述：** 外部分支复用 `forward()`，响应头只去掉传输相关字段，响应体逐块原样发送。若上游错误信息或调试头包含收到的 Authorization，llama-web 会把自己的上游凭据交给客户端。决定 56 ④、阶段 10 验收要求上游真实 key 对客户端不可见；当前实现只保证“自己不主动填入”，没有覆盖上游反射凭据的路径。

**触发场景与证据：** 在内存中加载 `df5c658` 的真实代理模块，模拟上游返回 401 JSON（错误 message 含假 key）和携带假 key 的调试头，代理响应正文、响应头均包含该假 key。公网鉴权只决定谁能调用，不能阻止已获授权的客户端通过这条路径拿到权限不同的上游 key。现有测试专门断言错误响应原样透传，却未构造凭据反射。

**建议修改：** 明确安全错误透传规则，对外部上游错误响应使用安全错误结构或可靠的凭据脱敏，过滤可能反射认证信息的头。若还要求任何流式响应中都不得出现 key，需处理跨 chunk 的匹配，不能只逐 chunk 替换。增加错误 JSON、响应头、SSE 错误帧及跨 chunk 假 key 的测试。正常流式内容尽量保持现有透传语义；安全错误处理若需改变计划约定，应由用户确认。

### CR-002 · 高 · 等待期间独占状态改变，仍可启动本地模型

**位置：** `server/core/scheduler.ts:555`–`:557`、`:576`、`:589`–`:598`；执行独占卸载见 `server/service/context.ts:536`–`:539`。

**问题描述：** `blocked()` 仅在进入加载流程时检查一次。随后可能等待 admission、旧模型 draining 或卸载；等待结束后没有重新检查占用者，就创建 loading 实例并调用 launch。健康探测期间 `ops.stopAll()` 只能看到已经存在的实例，尚处于 admission 的任务不在快照里，因此一次卸载也不能覆盖这个窗口。

**触发场景与证据：** 在内存中运行目标版本 Scheduler：初始无占用者，多开 admission 被 Promise 暂停；等待过程中将占用者切为外部上游，随后让 admission 返回 fits。`acquire()` 成功并调用了 launch。生产中可能直到下一轮探测才停止这个新进程，期间本地模型与独占上游同时加载/运行，有显存不足风险，违背“独占期间一切本地加载被拒绝”。单开等待旧模型排空也存在同类检查窗口。

**建议修改：** 每次异步等待后、进入 loading / launch 前重新检查独占状态；将独占建立与待加载任务失效衔接起来，避免快照中还没有实例的任务逃逸。补充 admission 等待、排空等待、请求触发、手动启动、自动重载的竞态测试，并断言独占建立后没有新增启动。

### CR-003 · 中 · 自指地址检查遗漏回环别名和本机网卡地址

**位置：** `server/core/upstreams.ts:73`–`:90`；调用方 `server/service/upstreams-api.ts:18`–`:22`。

**问题描述：** 自指检查只识别几个主机名和 `0.0.0.0`，没有完整识别 IPv4 回环网段、IPv4 映射 IPv6 地址、本机 LAN 地址以及解析到本机的主机名。相同监听端口上的这些地址仍可作为上游保存。地址来自管理配置，不能据此认定任意公网请求能自行选择 SSRF 目标，但项目承诺的自指边界不完整。

**触发场景与证据：** 内存复现确认 `cleanBaseUrl('http://127.0.0.2:5001/v1', [5001])` 和 IPv4 映射回环地址都被接受。主入口绑定通配地址时，前者可回到本机主入口；本机 LAN 地址也会被当作其他机器。将这样的地址登记为上游，会错误回送到本地服务；如果 baseURL 还错误设置成管理接口前缀，外部转发可能落到免 key 的本机管理入口。是否形成持续环路取决于前缀和路径，不能把每个自指地址都称为无限递归。

**建议修改：** 结合实际监听地址、端口和本机地址集合判断自指；覆盖整个回环网段及 IPv4 映射地址。需要支持主机名时，对解析到的本机地址做校验，并考虑配置/监听变化后重新验证。保留“相同端口在其他机器可合法接入”的规则。增加回环别名、本机网卡地址、监听端口变化和真实回送的测试。

### CR-004 · 中 · 上游配置与 key 的保存失败会留下混合状态

**位置：** `server/api/upstreams/index.post.ts:13`–`:15`、`server/api/upstreams/[id]/index.post.ts:13`–`:14`、`server/api/upstreams/[id]/remove.post.ts:11`–`:12`。

**问题描述：** 先保存 upstreams.json，再保存 secrets.json；第二步出错时只向外抛错，既不回滚第一步，也不阻止代理/健康探测使用第一步结果。单文件原子写不能保证这两个关联文件的一致性。

**触发场景与证据：** 编辑时同时更换 baseURL 和 key，upstreams.json 写入成功，但 secrets.json 因磁盘、权限或损坏而写入失败：管理接口返回失败，新地址却已经生效，旧 key 仍绑定同一 upstream id。之后的代理及定时探测会把旧服务 key 发给新地址。新增时会留下未配 key 的接入项；删除时会留下孤立 key。调用顺序和 catch 分支直接确认了这些部分成功路径；本次未制造真实磁盘故障。

**建议修改：** 复用项目已有的双文件写入/协调机制，保证失败回滚或可恢复提交，并在提交完成前避免对外发布配置与凭据的混合版本。补第二次写失败、损坏 secrets、重启恢复，以及失败后代理目标和 Authorization 仍匹配的测试；不仅断言 HTTP 报错。

### CR-005 · 中 · 独占拒绝的 API 契约与计划不一致

**位置：** `server/core/proxy.ts:190`；手动启动路径 `server/service/admission.ts:73`–`:79`、`server/api/models/[id]/start.post.ts:16`–`:19`，重试入口有同类调用。

**问题描述：** Scheduler 把独占拒绝表示成 `no-room` / `reason: exclusive`，代理随后统一返回 `503 insufficient_memory`，没有返回决定 56 ⑨要求的 `503 machine_exclusive`。手动启动的前置检查也没有检查独占；单开时直接跳过检查，接口先返回 `{ ok: true }`，后台才拒绝加载。界面将按钮置灰不能约束直接调用管理 API 的客户端。

**触发场景与证据：** 外部上游已被探测为独占运行，请求一个未在线的本地模型，走到 `schedulerErrorResponse()` 的 no-room 分支，得到 `insufficient_memory`。手动启动在单开模式下先返回成功、后产生拒绝事件。已有测试仅核查内部 `SchedulerError` 的 reason，没有覆盖 HTTP 错误码和手动入口响应。

**建议修改：** 在独占分支返回计划指定的错误码和占用者文案；管理启动、重试在返回成功前检查独占状态，最终调度检查仍保留以防竞态。补非流式拒绝、冷加载 SSE 错误帧及管理启动/重试的 HTTP 层断言。若希望沿用后台事件契约，应先确认并修改计划，而不是将内部拒绝当成接口已符合要求。

### CR-006 · 中 · 待确认 · 原始网络异常直接进入错误响应、事件和诊断日志

**位置：** `server/core/proxy.ts:555`–`:557`、`server/service/context.ts:198`–`:208`；测试连接的类似路径为 `server/core/upstream-test.ts:16`–`:17`、`server/api/upstreams/[id]/test.post.ts:15`–`:16`。

**问题描述：** 外部请求失败时把原始异常对象传给 onEvent，把原始 message 放进 502；生产回调又将 message 写到诊断日志。测试连接同样把异常 message 返回页面。异常内容没有以实际保存的凭据做脱敏。CR-001 针对上游 HTTP 响应，本条针对 fetch 抛出的异常。

**触发场景与证据：** 向目标版本注入含假 key 的 fetch 异常，确认假 key 出现在 502 和 ProxyEvent；请求记录只保存安全错误码，没有包含该异常 message。生产日志回调的源代码也明确打印该 message。**待确认的是生产 Bun/Node fetch 或实际部署的网络层会否产生含认证信息的异常**：普通 ECONNREFUSED 测试不包含 key，不能据此声称生产已发生泄露，也不能证明这个边界总是安全。

**建议修改：** 对客户端使用固定安全文案，事件/日志仅输出结构化诊断字段或经过凭据脱敏的文本；测试连接复用同一安全策略。增加含假 key、URL、请求头诊断信息的异常注入测试，分别断言响应、事件、诊断日志和请求日志不泄露。真实网络异常格式另做 Bun/Node 验证。

## 重点项核查与验证限度

| 核查项 | 结果 |
| --- | --- |
| 正常请求记录与事件 | 上游 Authorization 由保存的 key 替换，客户端 Authorization 被过滤；记录保持白名单参数、token 数和带前缀模型名。异常/反射路径见 CR-001、006。 |
| 仓库泄露 | .gitignore 中 data/ 规则未变；9 个提交未加入 data/、secrets.json 或 .env。扫描新增行未发现未标记的常见 sk/Bearer/JWT 凭据模式；测试中的刻意假 key 已识别。未读取真实 data/secrets.json；模式扫描不是对所有格式密钥的证明。 |
| 公网入口鉴权 | public-entry 的路径与鉴权边界未被阶段 10 修改；仍限定 127.0.0.1、/v1/*，拒绝无效/吊销 key，其他路径 404，来源以进程内参数传递。现有公网测试通过。 |
| SSRF 请求侧边界 | model 只决定已登记上游及模型 id；baseURL 来自配置，请求体中的同名字段不能改变目标地址；转发、探测和连接测试均使用 redirect: manual。/api/upstreams 沿用管理来源检查，公网 listener 不进入 Nitro。局域网管理免 key 是原设计，不能误报为本次鉴权回归。自指检查不足见 CR-003。 |
| 流式取消 | 请求 signal 传播到上游 fetch；响应 body cancel 调用 ac.abort；取消会结束 request trace。现有真实 HTTP 假上游测试确认收到 abort。取消连接不等于能够证明第三方推理后端停止计算/停止计费，后者依赖实际服务实现，待真实服务核验。 |
| settings / secrets 迁移 | 此范围没有改 settings schema、迁移或 settings API。新增的是 secrets v3→v4 和缺失 upstreams.json 时的默认空列表。纯迁移复现保留了 API keys、revoked 状态、tunnelToken、cloudflareToken；相关现有测试通过。双文件编辑失败另见 CR-004。 |
| 独占卸载 | stopAll 经 ModelOps 停止本地实例，沿用 draining；健康检查每轮重新检查并卸载，三次失败解除独占，不自动重载已卸载模型。现有等待在途请求结束的测试通过。等待时的新加载竞态及错误契约见 CR-002、005。 |
| upstream-launcher 与进程规则 | realSpawn 使用参数数组、detached、ignore stdio、unref；没有调用 PidRegistry，close 只停等待，不杀外部服务。cancel 仅处理当前启动任务。残留清理仍要求 pids 登记、exe 位于 runtime、进程身份一致，未被本阶段修改，未发现扩大误杀范围的路径。Windows bat/cmd 的 cmd.exe /c 是决定 56 ⑩明确的例外；本次没有验证真实 Windows 命令转义或进程树。 |

## 缺失或不足的测试

除各意见附带的回归测试，还应补充以下验收证据：

- 外部流式取消的完整生命周期：收到响应头前断开、收到头但无 token 的静默流、慢客户端/背压、直接 cancel 响应体、关闭公网 listener；断言上游连接终止且只产生一条 aborted 请求记录。现有外部测试只覆盖读取第一块后 abort，没有核验记录结算。
- 管理接口 HTTP 集成：跨来源/非 JSON 写入、不能从公网设置 baseURL 或启动命令、保存失败后的持久状态，以及测试连接返回期间 baseURL 已改变的旧结果丢弃。当前多数测试停留在纯模块，无法保护薄路由的写入顺序。
- Windows 真实 bat/cmd 启动（带空格路径和参数）、取消进程树、llama-web 退出后服务仍在、运行后 pids.json 未登记。现有 argv 数组断言不能证明 cmd.exe 最终解释或 Windows 进程生命周期正确。本次不把未执行的 Windows 验证当成已确认缺陷。
- 真实外部引擎取消后的生成/计费停止。仓库交接中的历史真机验证属于历史记录，本审查没有重新执行。

## 实际执行的验证

1. `git status --short`、`git log --oneline cd7c365^..df5c658`、`git diff --stat cd7c365^ df5c658`，以及相关 `git show` / `git diff df5c658 HEAD`：确认范围、调用链及后续改动边界。
2. `bun run -` 内存复现：通过 git show 读取目标提交源码，TypeScript 转译后内存加载，不创建脚本或工作树。第二次执行 5 组检查全部通过：自指校验遗漏、异常 message 凭据泄露、HTTP 响应反射凭据、独占 admission 竞态、secrets 迁移保留。第一次执行失败在测试断言：WHATWG URL 把 IPv4 映射 IPv6 规范化为十六进制，本来错误地要求字符串原样相等；修正内存断言后重跑通过。没有修改仓库文件。
3. `bun test tests/core/upstreams.test.ts tests/core/upstream-health.test.ts tests/core/upstream-test.test.ts tests/core/public-entry.test.ts tests/core/origin.test.ts`：**54 pass / 0 fail**。
4. `bun test tests/core/proxy-external.test.ts`：**14 pass / 0 fail**，含真实 HTTP 假上游取消和图片压缩三态。
5. `python3 -` 对 9 个提交的新增行和路径做只读凭据模式扫描：未发现运行数据路径或未标记的常见凭据模式；未打印任何可能的密钥值。
6. `git diff --check`：写报告前后均通过；报告为未跟踪文件，另以 `git diff --no-index --check /dev/null docs/reviews/stage-10-codex.md` 检查。最终工作区只有本报告新增，以及审查期间出现、未由本次写入的 docs/plan.html 修改。

运行环境为 macOS arm64、Bun 1.3.11。现有测试是在当前工作树执行：5 个测试文件和相关 upstream-health / upstream-test / scheduler / model-ops / keys / public-entry / origin 的实现与目标版本一致；upstreams.ts 仅增加后续的类型字段，proxy.ts 的后续改动主要为错误文案处理，外部转发及取消链路未变。因此这些测试为相关行为的辅助证据，**不是在 df5c658 独立检出后跑过全套测试的声明**。关键缺陷复现则直接加载 df5c658 源码。

没有运行全量 `bun test`、typecheck、build，没有启动应用、真实模型、GPU、Cloudflare 隧道或收费上游，没有进行真实磁盘故障和 Windows 进程测试。测试用短期 HTTP 服务由各测试清理；没有保留任务自建服务或临时脚本。
