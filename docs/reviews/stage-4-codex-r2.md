# llama-web 阶段 4 Codex 复审（第二轮）

日期：2026-10-02。结论：**需要再修正**。

CR-001～CR-013：**6 条确认已修复、7 条部分修复、0 条未修复**。本轮列出 9 条后续意见：高 1 条、中 7 条、低 1 条。完整测试和类型检查通过，但新增测试尚未覆盖下面的反例。

> 处理结果（2026-10-02，Sonnet 5.5）：CR-014～CR-022 共 9 条全部核实成立并已修复。第一部分 7 条「部分修复」的缺口由这 9 条覆盖：CR-001→014/015，CR-002→022，CR-004→016，CR-005→017/018，CR-007→019（两次写入之间被杀的恢复仍未做，已在交接披露），CR-009→020（解压无取消 / 时限仍是披露的边界），CR-012→021。CR-010 的「匿名注册 + 带索引注销」混合格式为待确认项，没有改动。

## 范围与依据

已按顺序读取全局路由规则、AGENTS.md、上一轮审查及各条「处理结果」、最新交接；另核对 docs/plan.html 的核心行为规则、阶段 4 任务和验收标准。按 code-review 及脚本、资源生命周期、多步写入审查规则核对。

`git log --oneline 1d5c7a6..HEAD` 确认范围只有两个修复提交：

| 提交 | 内容 |
|---|---|
| 09460b8 | 凭据 guard、Cloudflare 配置安全、隧道与更新生命周期修复 |
| c9dd9a8 | CR-006 方案 A：失败恢复提示 |

这是阶段 4 修复复审。局域网免 key、secrets.json 明文和 allowSwitch 留坑按既定要求处理。CR-006 按用户选定的方案 A 验证，不要求自动认领资源。

开始时工作区干净。只新增本报告，不修改代码、测试、计划或交接，不提交。报告中的行号基于 c9dd9a8。

## 原意见逐条核对

下表的 V 编号对应末尾「实际验证」。对旧代码的反证使用 `git show 1d5c7a6:<文件>`，在内存中转译、加载相关模块并执行等价场景；没有切换工作区，也没有把整套新增测试替换到旧 checkout 运行。没有实际执行的旧版本验证明确标为静态反证。

| 编号 | 结论 | 修复与测试依据；处理结果是否属实 |
|---|---|---|
| CR-001 | **部分修复** | `scripts/pre-commit:39–47` 确实拒绝常见 Base64 隧道 token 和单行 API token 赋值。新增测试 `tests/platform/pre-commit.test.ts:90–147` 使用运行时假值并检查不打印值；V03 对同一合成 diff 的旧 hook 返回 0、新 hook 返回 1，具有回归意义。但多行赋值、其他常见环境变量名仍漏报，正常表达式也误报，见 CR-014、015。「已修复」不足以描述覆盖范围。 |
| CR-002 | **部分修复** | `server/core/cloudflare.ts:659–683,792–793` 记录旧 DNS，先恢复再删除新隧道，原触发场景已闭合。测试 `tests/core/cloudflare.test.ts:337–354` 检查实际记录恢复；V04 旧版恢复为 false、新版为 true。`356–368` 的外部改指测试是有效补充，但旧版本来就不恢复 DNS，这条单独不能证明原缺陷修复。新判断只比较 content，仍会覆盖他人对 proxied 的修改，见 CR-022；「他人改动则不回退」说得过宽。 |
| CR-003 | **确认已修复** | `server/core/cloudflare.ts:420–423,539–545,768–771` 保留完整 config、将其纳入 fingerprint/configHash、PUT 原样回传非 ingress 字段。测试 `tests/core/cloudflare.test.ts:371–395` 采用整体替换的 fake，覆盖字段保留与首次 apply 前的全局变化；V04 旧版保留为 false、新版为 true，旧实现也不会把全局字段变化纳入 fingerprint。真实 API 的缺省字段语义确实没有验证，但修复已经不依赖该语义，理由成立。重试时的跳过漏洞另见 CR-017。 |
| CR-004 | **部分修复** | `server/core/cloudflare.ts:369–381` 原位替换修复了原来的同主机名路径遮蔽；V04 旧版具体路径不在首位、新版在首位。`tests/core/cloudflare.test.ts:38–80` 的正常路径断言有效，但通配路径未覆盖；`72–77` 甚至把目标规则仍被通配宽泛规则遮蔽的顺序写成预期。见 CR-016，「新规则在遮蔽它的规则之前」并非总成立。 |
| CR-005 | **部分修复** | `server/core/cloudflare.ts:759–771` 增加写入前检查。`tests/core/cloudflare.test.ts:397–432` 覆盖目标被改为其他服务，以及 PUT 成功后丢响应。V04 前者旧版静默覆盖、新版拒绝；V05 后者旧版为 done、新版为 skipped，新增断言确有区别。但「已等于结果」并未比较原计划的完整预期配置，见 CR-017；当前本地端口检查也确实未做，且理由不能消除失效地址，见 CR-018。 |
| CR-006 | **确认已修复（按方案 A）** | `server/core/cloudflare.ts:750,783,768` 的 changed detail 分别进入 `app/composables/useFormat.ts:69–70`，再由 `app/components/PublicCfRun.vue:65–69` 显示；`i18n/zh-CN.ts:723–725` 给出放弃后重新预览的步骤。V10 实际调用三个格式化分支，均精确返回对应提示。DNS 丢响应后若记录已满足目标，会在 `cloudflare.ts:779–780` 跳过；只有出现不符合目标的记录才走 dns-appeared，提示用了「可能」，没有把它断言成自己的资源。保留原恢复方式符合用户决定。没有新增浏览器/提示回归测试，也没有运行浏览器验证；这是验证边界，不重新要求认领方案。 |
| CR-007 | **部分修复** | `server/core/write-pair.ts:5–17` 在第二次同步写失败时回滚第一份；`context.ts:294–306` 延迟托管切换，闭合了普通写失败的原路径。`tests/core/write-pair.test.ts:16–55` 用真实 JsonStore 验证文件回滚和异常，确有作用，但仅测试新 helper，没有验证实际 hold/监听器/公网托管接线，不能独立证明原副作用不存在。V07 复现失败期间漏应用手改配置，见 CR-019。交接承认两次写入之间被杀的恢复没做，这一说明属实：没有持久事务记录，重启仍可能使用半更新组合；原建议的重启恢复测试也缺失，不能据此称完整事务已闭合。 |
| CR-008 | **确认已修复** | `server/core/tunnel.ts:405–407,437–450` 取消并等待 prepare；`196–215` 使用每次唯一下载临时名并 finally 清理。`tests/core/tunnel.test.ts:387–432` 检查峰值并发为 1、旧 signal 被取消及 shutdown 等清理；旧实现不传 net.signal，静态反证这些测试会失败。V06 使用兼容旧接口的 gate 再确认旧版峰值 2、新版 1；V09 实际取消假下载后 body 已取消、临时目录无文件。自定义 prepare 不响应 signal 时会一直等，处理结果已明确说明；默认网络实现有取消/停滞边界，本轮未发现 prepare 与 reconcile 相互等待的死锁。 |
| CR-009 | **部分修复** | `server/core/llamacpp.ts:88–142,194–211` 增加头/body/停滞边界；`updater.ts:177–180` 与 `context.ts:349` 加入关机取消。`tests/core/updater.test.ts:234–270` 覆盖不返回的头、body、下载停滞及 stop，555 条完整测试均通过。静态反证：旧请求无应用定时器，前三种场景不会在测试期限内落到 error，旧 Updater 没有 stop。V09 成功请求后外部 signal 监听器为 0，取消下载清理有效；但预先取消会产生未处理拒绝，见 CR-020。解压等待未加取消/时限，交接明确披露，本轮没有执行真实解压阻塞验证。 |
| CR-010 | **确认已修复** | `server/core/tunnel.ts:519–529` 先按词边界识别注销，并用 connIndex 集合；`tests/core/tunnel.test.ts:378–390` 与 flap fixture 检查完整计数序列。V06 同一条注册后注销，旧版仍 connected/2，新版 starting，原问题已消除。缺失 connIndex 时回退为匿名计数；混合「匿名注册、带索引注销」仍会残留计数（V06），但真实日志是否会混合这两类格式**待确认**，现有测试没有覆盖该边界，不将其当作已证实的新线上缺陷。 |
| CR-011 | **确认已修复** | `server/core/tunnel.ts:487–495` 登记成功后才保留 child，失败记录 killing；`407,433` 在 teardown/下一次准备前等待。`tests/core/tunnel.test.ts:434–460` 实际创建假进程，检查被结束、修复后手动重试连接成功和登记仅一条；完整测试通过。静态反证旧版登记失败提前返回，this.child 不被清空，retry 被非空 child 拦截，这条测试会无法连接。登记失败同时 shutdown、taskkill 本身失败/挂起没有新增覆盖；本轮未制造这些真实故障。 |
| CR-012 | **部分修复** | `server/core/live.ts:57–59,256–266`、`context.ts:309` 确实把任务接入快照并通知；`useCloudflareSetup.ts:23–25` 监听它。`tests/core/live.test.ts:35–50` 检查 job 字段和变化推送；静态反证旧 snapshot 丢掉 cloudflare，相关断言会失败。但该测试没有调用 composable，也没有模拟刷新/跨标签页请求竞争。V08 实际执行 composable，晚到 GET 把 done 改回 running，见 CR-021；因此「刷新/另一标签页都会更新」仅覆盖无竞争路径。 |
| CR-013 | **确认已修复（当前树）** | `git diff 1d5c7a6..HEAD -- docs/handoff.md` 确认原具体名称及机器标识已泛化，当前文档修复属实，无需为文案替换补单测。已推送历史仍含原内容，处理结果如实披露；历史清理未获用户决定，也不在这两个修复提交内，不能把本次修复描述成历史已清除。本轮没有重写历史。 |

## 后续审查意见

### CR-014 · 高 · 凭据 guard 仍漏掉常见的多行赋值和环境变量格式

- **位置**：`scripts/pre-commit:23–30,43–46`；测试 `tests/platform/pre-commit.test.ts:113–134`。
- **问题描述**：扫描逐行进行，API token 规则要求名称和值同一行；名称列表也遗漏常见的 CF_TOKEN。单行赋值测试通过不能证明格式覆盖已完整。
- **触发场景**：格式化后的源码把 cloudflareToken 的字符串值放到下一行，或脚本使用 CF_TOKEN 保存 API token；假值换成真实值即可经正常 hook 提交。
- **证据**：V03 用同一实际 hook 和合成 staged diff：单行已知名称返回 1，多行赋值及 CF_TOKEN 返回 0；没有放行标记，未打印任何值。原 CR-001 的主要格式已修，但新增测试未覆盖这些反例。
- **建议修改**：补充常见凭据名称、引号/分行赋值上下文；对待提交文件使用有边界的上下文识别，避免只靠单行名称相邻规则。补充拒绝测试，并保持错误输出不含值。
- **处理结果**：**已修复**。核实成立（分行赋值、`CF_TOKEN` 都漏）。hook 现在：名称列表扩为 `cloudflare|cf` + 可选 `api` + `token|key`、`api_token`、`tunnel_token`、`auth_token`；记住上一条新增行，名称在上一行末尾、值在本行开头时同样拒绝；报错仍不打印值。新增测试覆盖分行对象、分行赋值、`CF_TOKEN`、`CF_API_KEY`、yaml 写法。

### CR-015 · 低 · 凭据赋值规则把正常函数表达式当成密钥

- **位置**：`scripts/pre-commit:43`；测试 `tests/platform/pre-commit.test.ts:136–150`。
- **问题描述**：规则只要求分隔符之后出现 30 位名称字符，不要求是字符串字面量或凭据值，因此长函数名/变量名也会被拒绝。现有正常代码测试只用了较短的表达式。
- **触发场景**：提交正常源码 `const tunnelToken = extractTokenFromPastedCloudflaredCommand(raw)`；不含任何凭据，也会被阻止。
- **证据**：V03 对这条源码，旧 hook 为 0、新 hook 为 1。现有夹具放行标记仍有效，但要求正常代码也加「假密钥」放行会掩盖扫描问题。
- **建议修改**：区分代码中的表达式与字面量，针对环境变量/文档另设明确上下文；补长标识符、正常函数调用的允许测试，同时保留真正长值的拒绝测试。
- **处理结果**：**已修复**。核实成立：规则只要求 30 个字符。现在要求匹配到的值里含数字（真实 token 必有，长标识符 / 函数调用没有）；新增允许测试：长函数调用、长变量名、分行的长函数调用。

### CR-016 · 中 · ingress 新顺序仍会遮蔽路径服务或使新增目标不可达

- **位置**：`server/core/cloudflare.ts:374–379`；错误预期 `tests/core/cloudflare.test.ts:72–77`。
- **问题描述**：插入位置把所有匹配通配主机名都当成宽泛规则，不区分带 path 的通配规则，因此新目标宽泛规则会遮蔽已有通配路径服务。另一方面，倒序查找同主机名规则会把插入点移到宽泛通配之后，使新增规则根本无法匹配。
- **触发场景**：①已有「匹配目标的通配主机名 + 特定路径」后新增目标宽泛规则；②已有宽泛通配规则，其后有同主机名路径规则，再新增该主机名。
- **证据**：V04/V11 调用实际 mergeIngress：①新 service 在第 0 条，路径规则退到第 1 条；②宽泛通配仍第 0 条，新目标在第 2 条。按从上到下匹配，分别造成原路径服务被遮蔽、目标不可达。现有 late 测试直接接受②的数组顺序，未验证请求实际命中哪条。
- **建议修改**：明确区分覆盖目标的路径规则和宽泛兜底规则；无法同时保留既有匹配语义并让目标可达时，阻止自动合并并展示冲突。测试按主机名和路径验证最终命中服务，不只检查数组排列。
- **处理结果**：**已修复**。核实成立，两个反例都复现。新规则放在第一条「无 path 且会命中该主机名的规则（匹配通配 / catch-all）」之前、所有带 path 的规则之后（带 path 的通配规则不再算宽泛规则）；原本就排在宽泛规则之后的同主机名路径规则本来就不可达，不再把插入点推到它后面；目标自己的规则如果排在宽泛规则之后，会移到它前面。测试改为按「主机名 + 路径」用一个模拟 cloudflared 匹配的函数断言最终命中的服务（含其他主机不变），并把原先错误的 late 预期改掉。

### CR-017 · 中 · ingress 跳过判断没有比较本次计划的完整预期结果

- **位置**：`server/core/cloudflare.ts:761–768`。
- **问题描述**：m 是从最新 remote 计算的；只要最新目标 ingress 已使用 plan.service，m.rules 就可能等于 remote.ingress，随后直接跳过 configHash 校验。这只证明当前合并幂等，不能证明是上次自己的写入。其他 ingress、目标 originRequest 和隧道级参数的外部变更都会被一起接受。
- **触发场景**：ingress PUT 失败后，外部把目标设为相同 service，同时修改全局参数；用户点击重试。首次 apply 重新观察与 ingress 步骤之间也有相同窗口。
- **证据**：V04 在失败后设置目标为预期 service，并把全局超时从 5 改为 60：retry 返回 done，ingress 为 skipped，onSaved 执行 1 次。`tests/core/cloudflare.test.ts:415–432` 只覆盖未夹杂外部变更的丢响应结果。
- **建议修改**：在确认计划时保留完整原配置和完整预期配置/哈希；只允许「仍等于原配置」写入或「完整等于预期结果」跳过，其余返回 changed。补全局参数、其他规则、目标参数变化与响应丢失组合的测试。
- **处理结果**：**已修复**。核实成立。`SetupPlan` 新增 `resultHash`（预览配置合并目标规则后的完整结果）；ingress 步骤：远程配置哈希等于 `resultHash` 才算「上次写入已成功」跳过，等于预览时的 `configHash` 才写入，其余（含两者混合）一律 `changed / ingress-changed`。哈希对键顺序不敏感。新增测试：目标已等于预期、同时全局参数被改，重试被拒。

### CR-018 · 中 · 重试继续写旧端口，任务成功但入口与隧道不一致

- **位置**：`server/core/cloudflare.ts:642–647,762–771`；`server/service/context.ts:300`；`server/api/cloudflare/retry.post.ts:8`。
- **问题描述**：retry 不重新读取当前公网端口，继续使用 plan.service；保存只设置开关/域名，保留当前 settings.public.port。于是任务完成后，隧道指向旧端口，实际入口监听新端口。CR-005 处理结果承认未做端口校验，但「写的是确认过的值」不能保证它仍对应正在监听的服务。
- **触发场景**：预览端口 8080 → ingress 失败 → 将公网端口改为 8081 → 重试成功。端口变化发生在初次 apply 中途也有同类问题。
- **证据**：V11 使用实际 CloudflareSetup 和 fake，失败期间改变本地端口后 retry 返回 done，remoteService 仍为 `http://127.0.0.1:8080`，localPort 为 8081。调用链没有读当前端口的 retry 参数/回调；context 的保存逻辑也不恢复预览端口。没有启动真实监听器来验证最终 502。
- **建议修改**：每次推进/重试前校验当前本地端口与确认计划一致，变化时要求重新预览；把本地监听目标作为任务一致性条件，而不是静默改回用户的新设置。补入实际配置接线测试。
- **处理结果**：**已修复**。核实成立。`SetupHooks.localPort`（接到当前 `settings.public.port`）：每一步开始前比较，预览确认的端口与当前不一致就以 `changed / port-changed` 失败，不改写隧道；改回原端口后可以继续重试。新增测试，并给出界面文案。

### CR-019 · 中 · hold 期间读取手改配置后写失败，回调被永久漏掉

- **位置**：`server/service/context.ts:155–158,294–306`；`server/core/store.ts:139–147,161–165,180–181`。
- **问题描述**：两次写入同步执行，普通异步 watcher 不会在 hold 中间插入；但 store.update 的 refresh 会同步通知尚未处理的手改。hold 把应用回调屏蔽，却没有记录待重放；异常时 finally 只减计数，后面的 applyPublic 不执行。refresh 已把文本标记为 lastWritten，后续 watcher 会跳过它。
- **触发场景**：手改公网 enabled 为 false，100ms debounce 尚未执行；一键保存 refresh 读到了这次手改，但随后 settings 写入失败。token 回滚成功，缓存/磁盘认为公网已关，实际入口仍开着。
- **证据**：V07 用实际 JsonStore/openStore/writePair 和从 context 读取的 onSaved 函数，注入第二份 save 故障；等 250ms 后 cachedEnabled=false、applyCallbacks=0、applyPublicCalls=0、tokenRestored=true。没有运行真实公网入口。现有 write-pair 测试只检查文件值，没有这一接线场景。
- **建议修改**：hold 期间记录哪些配置发生变化，退出 hold 后在成功/失败路径都按最终有效状态重放必要应用；区分回滚失败的状态并明确报错。补「尚未被 watcher 处理的有效手改 + 第二写失败」集成测试。
- **处理结果**：**已修复**。核实成立。新增 `Hold`（`core/write-pair.ts`）：持有期间屏蔽回调，结束时无论成功失败都做一次 `applyPublic()` 对账，不再丢失期间被 refresh 读到的手改。新增 `Hold` 单测（成功、失败、嵌套）。**没有**对完整 `context` 接线做集成测试（该模块依赖整套单例），回滚失败本身仍以 `AggregateError` 报告。

### CR-020 · 中 · 预先取消会留下未处理的底层 Promise 拒绝

- **位置**：`server/core/llamacpp.ts:75–82,112,136`；相关下载推进 `283–288`。
- **问题描述**：fetchFn/res.json 的 Promise 在传给 abortable 前已经创建。signal 已取消时，第 77 行直接拒绝外层，未给这个已有 Promise 安装处理器；底层因取消而拒绝会成为 unhandledRejection。调用方 catch 到 RuntimeError 也不能消除它。
- **触发场景**：关机时更新器正等待第一份归档解压；解压结束后下一次下载使用已取消 signal。或任何预先取消的 getBody/getOk 调用。
- **证据**：V09 分别以拒绝型 fake fetch 和 Bun 原生 fetch 调用预先取消的 getBody；已 catch 外层错误，仍各收到 1 次 unhandledRejection。原生 fetch 使用预先取消 signal，不发实际网络请求。现有 stop 测试只取消已经挂起的请求，未覆盖先取消再进入请求。
- **建议修改**：开始网络/body 操作前检查取消，或让 abortable 始终给传入 Promise 安装拒绝处理器，包括预先取消分支。补预取消、解压等待期间关机后推进下一下载的测试，断言没有未处理拒绝且临时文件清理完毕。
- **处理结果**：**已修复**。核实成立（预取消时底层 Promise 的拒绝没人处理）。`abortable` 先给传入的 Promise 装好处理器再判断取消；`fetchChecked` 在已取消时根本不发请求。新增测试：拒绝型 fetch、忽略 signal 的 fetch、原生 fetch，均断言请求数为 0、没有 unhandledRejection。

### CR-021 · 中 · 延迟请求返回值会覆盖更新的 live 任务状态

- **位置**：`app/composables/useCloudflareSetup.ts:23–25,44–48,98–106`；`server/core/live.ts:248–250`。
- **问题描述**：watch 和 loadInfo/apply/jobAction 都无条件写 job，没有任务版本或请求时序检查。GET 已取到 running 的响应即使晚于 done 快照到达，仍会把状态改回 running。LiveHub 会去重相同快照，不能保证后续轮询再次推送 done 来纠正页面。
- **触发场景**：刷新/新标签页发出 loadInfo；服务端完成任务，SSE 的 done 先到；稍后之前的 GET running 返回。跨标签页 dismiss/新任务与旧 POST 返回也有同类竞争。
- **证据**：V08 在 Vue 响应式环境直接加载真实 composable，只替换 Nuxt 全局和可控制的 fetch：先收到 live 后 job=done，放行旧 GET 后 job=running，而 live 仍为 done。没有运行浏览器。新增 LiveHub 测试未执行 composable，不覆盖这一反例。
- **建议修改**：让 job 通过统一 live 流更新，或给任务和每次状态变更增加可比较版本，所有响应/快照只接受较新版本；同时考虑 null/dismiss 和新任务，单靠 finishedAt 不够。补慢 GET、慢 POST、跨标签页清除/新任务的时序测试。
- **处理结果**：**已修复**。核实成立（V08 的竞态是真的）。收到过 live 快照之后，job 只由 live 更新；GET / POST 的返回值仅在尚无快照时使用。新增 `tests/app/cloudflare-setup.test.ts`（用最小的 Nuxt 全局桩运行真实 composable）：慢 GET 不会把 live 的 done 改回 running；live 清除 / 新任务被跟随；无快照时用响应。**没有**浏览器验证。

### CR-022 · 中 · DNS 恢复只比较内容，会覆盖他人的代理开关修改

- **位置**：`server/core/cloudflare.ts:659–667,792–793`。
- **问题描述**：cleanup 以 content 仍指向本次隧道作为唯一归属判断，随后同时恢复 content 和 proxied。外部保留目标但关闭代理时，代码仍会把代理开关改回旧值，违背「别人改动后不回退」的处理说明。
- **触发场景**：原记录 proxied=true；本次改指新隧道，后续 token 获取失败；用户在远端保留指向但把 proxied 改为 false；随后放弃任务。
- **证据**：V11 对实际 setup/cleanup 和 fake 执行该序列，外部设为 false 的开关被改回 true，content 也恢复到旧值。新增测试 `tests/core/cloudflare.test.ts:356–368` 只修改 content，没有覆盖同内容的其他字段变化。恢复先于删除的顺序本身正确。
- **建议修改**：记录本次写入前后完整的相关 DNS 字段，恢复前比较当前 type/content/proxied 是否仍等于本次结果。若仍引用新隧道但相关字段被外部改变，应保留恢复信息并报告冲突，避免一边跳过恢复一边直接删除其依赖；补代理开关变化及恢复失败重试测试。
- **处理结果**：**已修复**。核实成立。cleanup 现在比较本次写入的结果：记录仍指向新隧道但 `proxied` 已被改（不再是本次写入的 true）时，不覆盖、不删除新隧道，任务保持失败并保留恢复信息（`changed / dns-modified`，有界面文案）；记录已指向别处或已不存在则照旧继续清理。新增测试（改代理开关后拒绝清理；处理后可以放弃）。

## 实际验证与限制

| 编号 | 实际命令/方法 | 结果 |
|---|---|---|
| V01 | `git status --short`、`git log --oneline 1d5c7a6..HEAD`、范围 diff、相关代码和测试读取 | 起始干净；范围为上述两个修复提交；核对 13 条处理结果 |
| V02 | 在当前 PowerShell 进程的 PATH 临时加入已有 Git 的 POSIX 工具目录，运行 `bun test`；另运行 `bun run typecheck` | Bun 1.3.14：**555 pass、0 fail、0 skip**，38 个文件、2883 次断言，57.93 秒；11 条 pre-commit 测试全部执行。类型检查退出码 **0**。PATH 已恢复，未改持久配置 |
| V03 | `bun run -`：stdin 脚本读取旧/新 hook，以 Git POSIX sh 和合成 staged diff 执行 | API 单行赋值/Base64：旧 0、新 1；正常长函数调用：旧 0、新 1；多行赋值、CF_TOKEN：旧/新均 0。另测带引号的命令参数同样为 0，但实际 Base64 隧道 token 还有独立 eyJ 检查，不能由该假 API 格式反例断言真实隧道命令也漏报。没有修改索引，没有打印值 |
| V04 | `bun run -`：读取旧 Cloudflare 模块并内存转译，旧/新都使用 FakeCloudflare 和相同关键场景 | DNS 恢复、全局字段保留、原同主机名路径优先、目标外部修改拒绝：旧均 false、新均 true。新 skip 判断在全局参数变化且目标等于预期时仍 done/skipped/save=1 |
| V05 | `bun run -`：旧/新模块执行 PUT 生效但响应丢失，再重试 | 旧 ingress=done，新 ingress=skipped；证明新增 skipped 断言对旧代码有区别 |
| V06 | `bun run -`：旧/新 TunnelManager 使用可控 prepare gate、内存 EventEmitter/PassThrough 假子进程 | 旧 prepare 峰值 2、shutdown 返回时仍有 2 个；新峰值 1、取消后 0 个。注册再注销：旧 connected/2，新 starting。新匿名注册后带索引注销仍 connected/1；真实混合日志格式未确认。没有启动 cloudflared |
| V07 | `bun run -`：临时目录的真实 JsonStore/openStore/writePair，读取并执行 context 的 onSaved，注入第二次 save 故障 | 等 250ms，手改已进入缓存、token 已回滚，但应用回调没有重放。未启动完整 context 或真实监听器。首次 helper 构造函数有语法错误，修正后重跑；初次失败不作为证据，两次临时数据均已清理 |
| V08 | `bun run -`：Vue ref/watch/nextTick + 真实 useCloudflareSetup，可控制 GET 返回顺序 | done 快照先到；旧 GET 后到将 job 改为 running。只模拟 Nuxt 全局/fetch，没有浏览器验收 |
| V09 | `bun run -`：getBody 监听器/预取消验证；prepareCloudflared 下载假响应、取消并检查临时文件 | 10 次成功请求后外部 abort 监听器 0；假下载取消后 bodyCancelled=true、filesRemaining=0。预取消 fake/native fetch 均有 unhandledRejection=1。临时目录已清理；未访问真实下载端点 |
| V10 | `bun run -`：真实 cfErrorText 与 i18n 三个 changed 分支 | 三者都精确命中对应提示，并包含重新预览步骤 |
| V11 | `bun run -`：实际 mergeIngress/setup/cleanup + FakeCloudflare | 通配路径被新规则遮蔽；端口变化后 retry done 但远端仍用旧端口；外部 DNS proxied=false 被恢复为 true。没有真实账号副作用 |
| V12 | `git diff --check`、报告结构/内容检查、最终 `git status --short` | 检查通过；只有本报告新增，无代码/测试/计划/交接修改，无提交 |

没有运行 build、启动真实模型/GPU、真实 cloudflared、真实 Cloudflare API 或账号操作、真实更新下载/解压、真实公网监听器故障验收、浏览器刷新/跨标签页验收；没有读取 data/secrets.json、用户真实配置或日志。没有重跑历史交接里的真机结果，也没有为本次复现新增/修改仓库测试。

资源核对：guard 的定时器与外部监听器在 finally 清理；正常 settle 的 abortable 会移除监听器，取消事件的 once 监听器也会移除；下载 pipeline 受 signal 控制，生产调用方的 finally 清理工作目录已由测试/隔离取消验证。实际遗漏是预取消分支的 Promise 拒绝处理。TunnelManager 的准备取消/等待链没有发现内生死锁；自定义不响应取消、taskkill 挂起及外部解压卡住的无界等待仍是未验证边界，不能把「shutdown 一定在固定时间内完成」当作本轮结论。

公网鉴权、排队/draining、断开连接和进程树原回归在完整测试中通过。这两个提交没有改变上述核心调度规则，本轮未发现明确的新绕过；当前报告要求再修正的依据是以上已复现的凭据保护、配置一致性和状态/取消处理遗漏。
