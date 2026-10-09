# 阶段 10 修复复审

日期：2026-10-09。结论：**rework required**。发现 3 项需处理的问题：高 1 项、中 2 项。没有修改实现或测试，没有提交。

## 本次边界

基线 HEAD：`f66ce82`。只审查用户指定的未提交修复：`git diff HEAD -- server tests`，以及新增的 `server/core/redact.ts`、`tests/core/redact.test.ts`。位置和行号均指本次工作区源码。上一轮报告作为原始失败条件的依据，沿用原发现编号；新发现使用 CR-007。

只在核实调用链时读取相邻的 store/ref、启动/首次设置接口、前端错误处理和本地 h3 实现，没有重新审查整个阶段 10。**未读取或修改本次无关的 docs/plan.html 改动**。本次唯一保留的新文件为本报告；其他未提交和未跟踪文件均为复审基线。

按 code-review 技能执行闭环复验。用户已经选择“将 key 原文替换为 `***`”，本报告接受该方案，不建议把上游错误一律改写。

## 需处理的意见

### CR-001 · 仍未完全关闭 · 高：合法的短 key 被所有脱敏路径跳过

**位置：** `server/core/redact.ts:8`、`:13`、`:17`、`:52`；保存接口校验 `server/service/upstreams-api.ts:42`–`:45`；测试 `tests/core/redact.test.ts:23`–`:25`。

**问题：** 保存接口允许任意非空、合规的短字符串作为 key，但 `MIN_KEY_LENGTH = 6` 让长度不足 6 的 key 在正文、响应头和异常 message 中原样通过。长度按 JavaScript UTF-16 code unit 计算，不是 UTF-8 字节数，部分非 ASCII key 也受影响。这是未向用户说明的安全例外，并未实现“已保存 key 原文出现就替换”。新增测试还把“短 key 不脱敏”固定成期望行为。

**触发条件：** 保存例如 `abc` 作为上游 key，上游在正文或调试头反射它，或者 fetch 异常含该 key。即使客户端只有 llama-web 的调用权限，仍能收到这个凭据。

**验证：** `bun run -` 内存脚本直接调用工作区 `createProxy()`，使用 key `abc`，模拟返回正文 `abc` 和 `x-echo: abc`；两个值均未被遮挡。另断言 `redactText('bad abc', 'abc') === 'bad abc'`。这些断言确认的是缺陷存在，不是修复通过。6000 组流算法验证的第一次修正后运行，也发现 5 个 code unit 的 Unicode 测试 key 被跳过，原因与此相同。

**建议：** 对所有非空已保存 key 执行原文遮挡，空 key 才作为无凭据处理。替换这个肯定短 key 泄露的测试，加入长度 1、5、6 的正文/头/异常，以及跨 chunk 短 key 的回归用例。若未来要限制凭据长度，需在保存边界明确限制并处理已有配置，不能只在脱敏层悄悄放行。

### CR-004 · 仍未完全关闭 · 中：回滚失败被吞掉，仍保留新地址与旧 key

**位置：** `server/service/upstreams-api.ts:31`–`:37`，尤其 `:36`。

**问题：** 单次 secrets 保存失败且 rollback 成功时，修复有效；但回滚的写入本身也可能失败。当前 catch 丢弃回滚异常，向外只报告原 secrets 错误，未暂停该上游，也没有持久恢复机制。此时 upstreams 的新配置已经发布，旧 key 仍保留，原来要消除的混合状态仍然存在。回滚失败不是普通回滚成功的等价状态。

**触发条件：** 编辑同时更换地址和 key：第一次 upstreams 写入成功；secrets 保存失败；恢复 upstreams 的备份/临时写入/rename 也因磁盘或 I/O 故障失败。新增时则仍保留创建项；删除时仍留下孤立 key。

**验证：** `bun run -` 从实际源码抽取并转译 `saveUpstreamsAndKeys()`，仅注入 ctx 的存储故障。第一次 upstreams 写成功，第二次 upstreams 写（rollback）抛 `rollback EIO`，secrets 写抛 `secrets EIO`。调用方只收到 `secrets EIO`，ctx 中仍是 `http://new.example/v1`，key 仍是旧假 key。另用系统临时目录中的真实 `JsonStore` + `openStore` 验证单次故障：structuredClone 可用，rollback 成功时磁盘和 ref 都恢复正确。没有对真实数据目录制造磁盘故障。

**建议：** 将回滚失败作为单独的恢复失败显式处理和报告，并防止继续向新地址发送旧 key；需要可恢复的持久状态或提交协议来覆盖重启。补“第二次写失败且回滚也失败”的测试，断言不仅报错，而且上游不会继续使用混合配置。现有提交没有针对这个 helper 的测试。

**并发结论：** 该 helper 与 JsonStore 更新都是同步执行，没有 await；普通同一进程管理请求不能在两次写和回滚之间交错，因此本次**未发现**“回滚掉另一个并发 HTTP 请求写入”的路径。外部进程手改文件、进程崩溃或重启恢复没有做动态验证，不将这些条件写成已复现的并发缺陷。

### CR-007 · 新发现 · 中：HTTP 状态描述未脱敏，Node/h3 会把 key 交给客户端

**位置：** `server/core/proxy.ts:358`、`:391`。

**问题：** 新修复处理响应头值和正文，但创建下游 Response 时仍原样传递 `res.statusText`。上游若在 HTTP reason phrase 中反射认证信息，这个响应字段绕过全部脱敏。它属于同一个凭据保护边界，但上一轮反射测试没有检查这个字段。

**触发条件：** 上游返回例如 `HTTP/1.1 401 <保存的 key>`，通过 `nuxt dev` 的 Node/h3 路径调用外部模型。h3 的 `sendWebResponse()` 会把 Response.statusText 写进 Node 响应的 statusMessage。

**验证：** 先用 `bun run -` 验证代理返回的 Response.statusText 保留假 key；Bun.serve 的真实 HTTP 小测试显示本环境 Bun 会替换自定义状态描述，因此**未证明生产 Bun 路径会泄露**。随后用 `node -` 在内存中转译工作区代理，模拟上游带假 key 的 statusText，经真实 `http.createServer(h3.toNodeListener(app))` 返回；客户端 fetch 的 statusText 确认包含该假 key。测试用服务器在 finally 中关闭。没有启动 Nuxt 应用。

**建议：** 在这两个 Response 构造分支同样使用 key 原文遮挡 statusText，保持原状态码；补有 body、无 body 和 Node/h3 reason phrase 的回归测试。不需要重写上游错误正文。

## 原意见的关闭状态

| 编号 | 复审结果 |
| --- | --- |
| CR-001 | 部分修复。长度 ≥ 6 的 key 原文在正文、响应头和跨 chunk 流中已遮挡；短 key 残留见上文。statusText 的新增检查见 CR-007。 |
| CR-002 | 原 admission 等待竞态已修复，新增测试可保护该场景；额外验证旧模型 draining 等待后也拒绝加载。未发现等待排空后直接 break 的窗口或同一 job 两次 refuse。 |
| CR-003 | 原报告中的回环别名部分已修复，新增的两条拒绝断言有实际保护作用；原报告还提及本机 LAN 地址/解析到本机的主机名，本次修复没有处理它们，因此不将整个 CR-003 标为完全关闭。本次不重审或新增相同的阶段 10 问题。 |
| CR-004 | 单次 secrets 写失败的 rollback 和 ref 更新已验证；rollback 失败仍未关闭，见上文。 |
| CR-005 | 外部独占拒绝的非流式响应已返回 503 machine_exclusive；手动 precheck 在 multiLoad 判断前拒绝，checkedStart 映射到 409 reason exclusive。相关内存验证和新增代理测试通过。首次设置和前端退路见下文。 |
| CR-006 | 长 key 原文的 fetch 异常 message 遮挡有效，响应和事件不再带假 key；短 key 仍受 CR-001 影响。测试连接共用 redactText，编码后凭据不属于当前原文匹配能力。 |

## A–E 的补充核查

**A：StreamRedactor / pull。** 6000 组固定种子的 byte-level 切分比较通过，覆盖特殊字符、多字节字符被拆在字节中间、重复 key、重复前缀、空 chunk 和尾部仅有 key 前缀；比较对象为原文字节对应文本的非重叠替换。算法按字节处理，未发现对合法 UTF-8 的额外破坏。

代理的无内容缓存读取也已验证：响应构造后未读 body 时上游读取次数为 0；依次给出前半 key、空 chunk、后半 key，仅在合成 `***` 后产出一块；消费者暂停后不预读下一普通 chunk。carry 只保存 proper prefix，大小受 key 长度约束；有限输入下未发现死循环或绕过 `highWaterMark: 0` 的持续预读。

正常 EOF 会 flush 残留前缀，完整输出且只结算一次 trace。prefix 被暂存且读取等待时取消响应体，会触发上游 AbortSignal，等待的 read 结束，记录一次 aborted。读取异常会终止下游流并记录 aborted；此时不输出已暂存的尾部，属于失败流而非成功响应截断的伪装。现有相邻 proxy 测试还覆盖租约释放、断连与 draining，均通过。没有重新验证第三方推理/计费停止或 Windows Bun 取消实现。

**原文匹配的能力说明：值得在计划中明确。** 内存验证确认 JSON 转义、URL 编码、Base64 回显不会被该原文字节匹配拦住。尤其 key 本身含引号或反斜杠时，JSON 错误正文可能自然形成这种回显，并非只能由恶意上游制造。建议未来说明“当前仅遮挡 key 原文，不保证覆盖编码/转换后的凭据”。这是用户已指定方案的能力边界，本次不要求实现编码识别，不修改计划，也不另记成未授权的新功能需求。

**B：scheduler。** `await evict(victim)` 和等待 others 的 Promise.race 都在循环末尾，后续回到顶部再检查；admission 后单独检查。`if (!why) break` 与 launch 之间没有异步等待；既有 reload / inst.evicting 等待也发生在进入检查循环之前。exclusive() 触发后立即 return，未发现双重 refuse。ready 提前返回只复用已在线实例，不启动新进程，沿用现有排空政策。取消请求的 waiter 会收到 cancelled，但已经 started 的切换 job 按旧约定继续收尾；验证中其随后遇到独占只产生一次 job 层拒绝事件，不能把这个事件误判为对请求重复拒绝。

**C：helper / created。** structuredClone 的对象和 JsonStore/openStore ref 机制兼容，真实临时存储验证已确认。正常 rollback 后，新增接口局部的 created 变量虽仍指向那次构造结果，但 helper 抛异常，路由不返回 createdId，也不触发后续 health.tick；未发现幽灵成功响应。普通管理请求无法插入同步 helper 中间。rollback 失败见 CR-004。

**D：admission / 界面。** 独占时，即使目标 ready，手动入口也会在 snapshot/多开判断前拒绝；没有触发新加载，这是有意收紧手动请求，不是内存检查回归。`setup.post.ts` 在 checkedStart 之前保存首次设置是已有约定，`start: false` 不经过该检查；`start: true` 且独占时，保存完成后启动返回 409，并不回滚已保存设置。

前端 `readStartGuard()` 对 exclusive 返回 null。`useModelActions` 随后调用 feedback.httpFailure；`FirstStartDialog` 的 catch 同样走 httpFailure，没有打开内存风险确认或提供强行启动。反馈提取服务器 message，因此仍会显示占用者说明；首次设置弹窗在该退路中没有像已知内存 guard 那样主动关闭。这里只读判断实际路径，未启动界面，未发现需要单独报告的崩溃或权限绕过。

**E：测试有效性与缺口。** 已在内存中装载 HEAD 旧版本核心函数，核对新增断言的等价失败条件：旧代理会原样回显正文/头、跨 chunk key、异常 message；旧地址校验接受新增的两种回环地址；旧 Scheduler 在 admission 中变独占后仍 launch；旧代理独占错误码仍为 insufficient_memory。说明这些新断言有实际回归作用，不是空断言。没有在磁盘上还原代码并跑一整轮旧版测试。

仍应补到仓库的测试包括：短 key 和 statusText；helper 单次失败、rollback 再失败及持久/内存状态；StreamRedactor 多字节字节切分、空 chunk、直接取消发生在暂存阶段、上游读取异常时 trace 仅一次；手动 checkedStart 的 409 exclusive 和首次设置退路。对应内存验证并不能替代长期保存的回归测试。新增 scheduler 测试目前用 tick(10) 判断已进入 admission，建议改为显式进入 gate 的信号，避免慢环境只测到循环顶部拒绝而漏掉目标时序。

## 实际运行记录

环境：macOS arm64，Bun 1.3.11，Node 24.13.0。

| 命令/验证 | 结果 |
| --- | --- |
| `git status --short`、`git diff HEAD -- server tests`、读取两个新文件及指定调用链 | 确认范围与基线；未读取 plan 内容或 diff。 |
| `bun test tests/core/redact.test.ts tests/core/proxy-external.test.ts tests/core/proxy-no-room.test.ts tests/core/scheduler-multi.test.ts tests/core/upstreams.test.ts tests/core/upstream-test.test.ts` | 79 pass / 0 fail。 |
| `bun test tests/core/proxy.test.ts tests/core/scheduler.test.ts` | 77 pass / 0 fail，共享转发/租约/调度回归通过。两次合计 156 pass。 |
| `bun run -` 流/代理内存脚本 | 最终 6000 个切分例和 EOF、空 chunk、背压、取消、异常、trace 检查通过；确认短 key 与 statusText 残留。 |
| `bun run -` 双文件 helper 故障注入 | 单次 secrets 失败正确 rollback；rollback 再失败时确认混合状态和异常吞掉。同步请求无法交错的检查通过。 |
| `bun run -` 真实临时 JsonStore/openStore | 磁盘和 ref 均恢复；系统临时目录、备份、watcher 已在 finally 清理。 |
| `bun run -` scheduler 内存复验 | 单开 draining 后独占拒绝一次、取消后的既有 job 行为、ready 复用检查通过。 |
| `bun run -` 手动 precheck / checkedStart / 编码反射 | 两种模式的独占拒绝和 409 数据确认；JSON/URL/Base64 回显保持原样。 |
| `bun run -` HEAD 旧函数对照；补充一次旧错误码脚本 | 新回归断言的等价失败条件全部核实；不是整轮旧测试。 |
| `node -` 代理 → Node/http/h3 → fetch | 实际收到带假 key 的状态描述；服务器已关闭。 |
| `git diff --check -- server tests` | 通过。报告另做未跟踪文件的 whitespace 检查。 |

**验证脚本的失败/更正也记录如下：** 流脚本第一次因随机字符串切到孤立 surrogate，比较了 JavaScript 原字符串而非编码后的文本，预期错误；先按 UTF-8 round-trip 规范化后，第二次因测试 key 只有 5 个 code unit，确认了短 key 跳过；改用长度 ≥ 6 的 key 验证算法，最终 6000 例通过。调度脚本第一次错误地预期“正在 admission 中最后一个 waiter 取消后，不应再产生 job 层独占事件”；源码约定 started 切换继续收尾，修正该假设后确认事件仅一次。旧版代理对照的最后一项第一次因混用了两个 SchedulerError 类导致 instanceof 不匹配，脚本返回 internal_error；用旧代理实际依赖的类重跑，确认旧 insufficient_memory。上述失败没有被算成测试通过，也没有据此误报实现缺陷。

没有跑全量 `bun test`、typecheck、build、Nuxt dev/preview、浏览器 UI、GPU、真实收费上游或 Windows 验证；没有修改、安装或部署任何实现。内存脚本未落盘；短期 HTTP 服务及系统临时目录均已关闭/清理。报告保留，工作区原有未提交改动保持原样。
