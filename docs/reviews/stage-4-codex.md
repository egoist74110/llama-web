# llama-web 阶段 4 Codex 审查

日期：2026-10-02。结论：**rework required（需要修正后复审）**。

> 处理结果（2026-10-02，Sonnet 5.5）：13 条里 13 条已处理（12 条修复 + CR-006 按用户决定选方案 A 加提示；CR-001/002/003/004/005/007/008/009/010/011/012/013，其中 CR-003 的真实 API 语义、CR-013 的已推送历史仍待用户知悉），0 条不成立。每条见其「处理结果」。

共 13 条意见：高 1 条、中 11 条、低 1 条。其中 CR-003 的真实 Cloudflare 缺省字段处理标注为「待确认」；其余结论由代码路径、现有测试或本次隔离复现支持。

## 范围与依据

已读取 AGENTS.md、docs/plan.html 的核心行为规则、阶段 4 任务与验收标准、变更记录，以及开发指南和最新交接。按 code-review 技能执行；脚本、鉴权、资源生命周期和多步写入另外按相应审查规则检查。仓库既定的「局域网免 key」「secrets.json 明文保存」「allowSwitch 留坑」视为已接受的要求，不作为缺陷。

`git log --format='%h %s' aef4cda..HEAD` 确认阶段 4 范围为 **aef4cda..1d5c7a6**（起点不包含，终点包含）。起点是阶段 3 审查修复提交，终点是阶段 4 更新／回退验收记录。

| 提交 | 内容 |
|---|---|
| 70ec195 | 4-1：公网入口、API key、公网设置 |
| cfe83b0 | 4-2：自动更新、版本清理、回退 |
| 6d99400 | 4-3：pre-commit、README、隧道方案调整 |
| 1b1325d | 4-4：隧道托管与验收 |
| 8a5bb72 | 4-5 计划调整 |
| f4f17bf | 4-5：Cloudflare 一键配置与沿用托管隧道 |
| 6b0732e | 4-6：公网引导、地址自检 |
| 1d5c7a6 | 4-6：真实更新／回退验收记录，无代码修改 |

检查以上提交的代码及必要的未改调用链：scheduler、model-ops、proxy、runner、residue、store、管理接口来源检查。没有修改代码、测试、计划或交接，也没有提交；本报告是唯一保留的新增文件。

## 审查意见

### CR-001 · 高 · pre-commit 不识别阶段 4 新增的两类凭据

- **位置**：`scripts/pre-commit:34–39`；相关格式：`server/core/cloudflare.ts:54`、`server/core/tunnel.ts:29`。
- **问题描述**：扫描只识别 `sk-`、Bearer 后的长串和长十六进制串。裸 Cloudflare API token 通常是字母／数字／下划线／连字符，隧道 token 是 Base64；二者都可以不匹配任何规则。写在普通源码或文档中时，路径限制也不能拦截。公开仓库的凭据提交保护因此漏掉了本阶段使用的主要凭据。
- **触发场景**：把裸 API token 或粘贴隧道安装命令放进 README、调试代码或交接文档，再正常提交。无需使用 `--no-verify` 或放行标记。
- **证据**：用合成 staged diff 驱动实际 POSIX hook（只替代 `git diff` 输出，不修改仓库索引）：构造的假隧道 token、假 Cloudflare API token均返回退出码 **0**；对照的假 `sk-` key 返回 **1**。三种都没有打印 token 值。
- **建议修改**：补充隧道 token 的格式识别，以及 `cloudflareToken`／API token 赋值和安装命令等凭据上下文检查；继续隐藏报错中的值。补上这些真实格式的拒绝测试，假数据仅在明确放行的夹具中使用。
- **处理结果**：**已修复**（2026-10-02）。核实成立：对照实际 hook，裸隧道 token / API token 赋值都能通过。`scripts/pre-commit` 新增三类拒绝：base64 隧道 token（`eyJ…`，也覆盖粘贴的 `service install` 命令）、`cloudflareToken` / `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` / `apiToken` / `tunnelToken` 后接 30 位以上的赋值、`--token` / `TUNNEL_TOKEN=` 后的长值；报错仍不打印值。`tests/platform/pre-commit.test.ts` 新增 3 条（运行时构造假 token，另含正常代码不误报的反例）。

### CR-002 · 中 · 放弃新建隧道时会留下指向已删除隧道的既有 DNS

- **位置**：`server/core/cloudflare.ts:621–635`、`server/core/cloudflare.ts:731–735`。
- **问题描述**：`dns:update` 修改的是已有记录，不会写入 `created.dnsRecordId`。后续步骤失败时，cleanup 删除本次新建的隧道，却既不恢复这条记录，也不提示它仍指向将被删除的隧道。旧地址会继续失效，且清理完成后丢失这次任务的恢复信息。
- **触发场景**：已有 CNAME 指向旧隧道 → 确认新建并改指 → DNS PATCH 成功 → 获取 token 或本地保存失败 → 点击放弃并清理。
- **证据**：用现有 FakeCloudflare 注入 token 获取失败，实际执行 apply／cleanup：`newTunnelDeleted=true`、`dnsStillPointsToDeleted=true`、`oldTunnelAlive=true`。
- **建议修改**：记录修改前与本次写入后的 DNS 状态；清理时先确认记录仍属于本次改动，再恢复原指向，最后删除新隧道。如果不自动恢复，应保留恢复信息并要求用户先处理该依赖，不能直接清理成功。补充「已有 DNS 改指后失败再放弃」测试。
- **处理结果**：**已修复**。核实成立：`dns:update` 不记录原状态，cleanup 只删隧道。`job.created.dnsRestore` 记录改指前的内容 / proxied；cleanup 先确认记录仍指向本次新隧道，再恢复原指向，最后删隧道；记录已被他人改动则不回退。界面的放弃提示补充「先恢复 DNS」。新增 2 条测试（恢复；他人改动后不回退）。

### CR-003 · 中 · 待确认：沿用隧道时发送的配置丢失全局 originRequest

- **位置**：`server/core/cloudflare.ts:386–392`、`server/core/cloudflare.ts:712–714`。
- **问题描述**：GET 配置后只留下 `config.ingress`，PUT 时只发送 `{ config: { ingress } }`。隧道级 `originRequest` 等其他配置未进入预览、fingerprint 或更新请求。若 PUT 按完整配置替换处理，其他主机名继承的 TLS、Host、超时或 Access 校验设置会丢失，违背沿用隧道时保留其他服务的约定。
- **触发场景**：已有隧道在全局设置 `originRequest`，多个主机名依赖该默认值，再通过一键配置添加 llama-web 地址。
- **证据与待确认边界**：代码丢弃字段、更新请求不携带字段是确定的；[Cloudflare 配置更新 API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/) 明确支持隧道级 `originRequest`。本次没有向真实账号执行 PUT，因此**缺省字段会被重置还是由服务端保留，以及实际影响，待确认**。现有 FakeCloudflare 只存 ingress，不能验证这一点。
- **建议修改**：保留完整远程 config，只修改目标 ingress；把其他配置纳入冲突检测。扩展 fake 与回归测试，覆盖全局参数保留；使用隔离隧道核实真实 API 的缺省字段语义。
- **处理结果**：**已修复（真实 API 语义仍未验证）**。代码层面成立：只保留并发送 `ingress`。现在读取并保留完整远程 config，PUT 时只替换 `ingress`；整份 config 进入 fingerprint 和 `configHash`。FakeCloudflare 的 PUT 改为整体替换（与审查描述的最坏语义一致）。新增 2 条测试（全局 `originRequest` 等保留；预览后全局配置变化被拒）。真实 Cloudflare 缺省字段是被重置还是保留**没有核实**（没有向真实账号执行 PUT），但无论哪种语义，现在都是原样回传，不依赖该答案。

### CR-004 · 中 · 合并 ingress 会遮蔽同主机名的既有路径规则

- **位置**：`server/core/cloudflare.ts:356–363`。
- **问题描述**：无路径限制的目标规则总被放在数组首位。同主机名的 `/admin/.*` 等路径规则虽然还在数组中，却排在宽泛规则之后，因而不能被命中。`others` 还排除了同主机名，使预览无法显示这类影响。
- **触发场景**：隧道原本先把一个主机名的特定路径路由到另一服务，随后以宽泛规则处理其余路径；一键配置复用这个主机名。
- **证据**：直接调用 mergeIngress，输出顺序从「路径规则 → 宽泛规则」变为「宽泛规则 → 路径规则」。[Cloudflare 官方说明](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/) 规定 ingress 从上到下匹配。
- **建议修改**：替换规则时保持原位置；新增宽泛规则时保留已有特定规则的优先级。预览应列出同主机名路径规则，无法安全合并时要求明确确认。补充路径规则和通配主机名的优先级测试。
- **处理结果**：**已修复**。核实成立：旧实现总把新规则放首位。`mergeIngress` 现在：已有规则原位替换；新规则插在同主机名路径规则之后、第一条也会命中该主机名的规则（匹配的通配主机名 / 仅路径规则 / catch-all）之前；catch-all 保持最后。同主机名路径规则列入 `others`（`host/path`），预览可见。新增优先级测试（路径规则、通配、位于通配之后的路径规则、无关通配）；更新了两处依赖旧顺序的断言。

### CR-005 · 中 · ingress 重试会覆盖预览后发生的修改

- **位置**：`server/core/cloudflare.ts:606–611`、`server/core/cloudflare.ts:712–714`。
- **问题描述**：fingerprint 只在首次 apply 时检查。ingress 写入失败后，retry 重新读取远程配置，却不比较目标规则与已确认版本，直接用旧 plan.service 覆盖目标。首次 apply 的观察与实际 ingress PUT 之间也有相同窗口。已有 DNS 步骤会检查旧值，但 ingress 缺少对应保护。
- **触发场景**：确认预览 → ingress PUT 失败 → 用户在 Cloudflare 后台修改同一主机名服务 → 在 llama-web 点击重试。端口在失败后被改动时也会继续使用旧 plan 中的端口。
- **证据**：FakeCloudflare 中先注入 PUT 失败，把远程目标改为 `http://127.0.0.1:9090`，再 retry；任务返回 done，目标被无二次预览地改回 `http://127.0.0.1:8080`。
- **建议修改**：每次写入前校验本步骤将修改的远程状态和当前本地端口。发现外部修改时返回 changed，并重新预览；对于可能已经成功但响应丢失的写入，单独识别「等于本次预期结果」。补上 apply 中途变化与失败后变化的测试。
- **处理结果**：**已修复**。核实成立：ingress 步骤无二次校验。复用隧道时，写入前重新读取：若远程配置已等于本次结果则视为上次写入成功（响应丢失）并跳过；若与预览时的 `configHash` 不同则返回 `changed / ingress-changed`，不覆盖，需放弃后重新预览。新增 2 条测试（失败后被外部修改再重试；响应丢失后重试识别自己的结果）。未做：重试时对比「当前本地端口」与预览端口——写入的是用户确认过的预览值，端口变化属另一类问题，如需处理请告知。

### CR-006 · 中 · 创建响应丢失后既不能重试，也不能清理新隧道

- **位置**：`server/core/cloudflare.ts:699–706`。
- **问题描述**：只有收到 POST 的成功响应后才记录 tunnelId 和 created.tunnel。远端创建成功但响应丢失时，重试查到同名隧道便抛出 changed，cleanup 因没有记录 ID 而无法删除它。任务提示可重试／清理，但这条故障路径实际需要用户手动处理。
- **触发场景**：Cloudflare 已完成创建，连接在响应到达前重置或超时。
- **证据**：包装现有 fake fetch，在创建副作用已完成后抛网络异常。首次为 network；retry 为 changed／tunnel-exists；cleanup 后仍有 **1 条存活的孤立隧道**。
- **建议修改**：为创建建立可验证的任务身份和恢复流程。出现同名资源时展示新观察结果并让用户确认接管／清理，不应仅凭名字自动认领外部资源；保留待恢复任务。补充「服务端已写入、客户端丢响应」测试，DNS POST 的同类故障也应覆盖。
- **处理结果**：**已按用户决定处理：方案 A（保持现状 + 界面提示）**。问题描述成立（创建响应丢失后重试得 `tunnel-exists`，cleanup 无记录 ID）。但修复的核心是「能不能认领一个同名且不是我们记录的隧道」，审查自己也说不能仅凭名字自动认领。现状的恢复路径：放弃 / 忽略该任务后重新预览，同名隧道会作为「沿用」选项出现，由用户确认（不会静默覆盖外部资源；DNS POST 丢响应同理，得 `dns-appeared`）。可选方案：A）保持现状并在界面提示这条恢复路径；B）认领创建时间晚于任务开始且无连接的同名隧道（有时钟偏差风险）；C）创建前生成一次性隧道名（改变用户看到的名称）。用户选 A（2026-10-02）：不自动认领；失败卡片对 `tunnel-exists` / `dns-appeared`（以及 CR-005 的 `ingress-changed`）显示具体恢复步骤——放弃后重新预览、在选项里确认（`useFormat.cfErrorText`、`i18n` 的 `changed-*`）。

### CR-007 · 中 · 本地保存失败可先替换正在托管的隧道

- **位置**：`server/service/context.ts:289–291`；回调副作用：`server/service/context.ts:155`、`server/service/context.ts:278–283`。
- **问题描述**：先保存 tunnelToken 并触发 applyTunnel，再保存 settings；第二步失败没有恢复第一步。两份文件各自的原子写并不能保证整个操作原子。已有公网／托管开关打开时，新 token 已足以停止旧连接并启动新连接，而任务仍会显示 save 失败。
- **触发场景**：已托管旧隧道 → 一键建立新隧道 → secrets 写入成功 → settings.json 因无效手改、备份失败或文件权限问题写入失败。旧地址可能已断开；随后 cleanup 还可能因新隧道已有 connector 而无法删除。
- **证据**：openStore.update 在写入后立即执行配置变化回调，secrets 的回调调用 applyTunnel；CloudflareSetup 仅将 save 标记为 failed，没有补偿路径。现有测试用数组收集 onSaved，未覆盖实际两份存储与托管接线。
- **建议修改**：为两份配置建立可恢复的保存事务／操作记录，在整体持久化成功后才应用托管切换；失败时恢复旧 token 或明确进入可恢复状态。补充第二份写入失败和进程重启后的恢复测试。
- **处理结果**：**已修复**。核实成立：secrets 写入立即触发 `applyTunnel`，settings 失败不会回滚。新增 `server/core/write-pair.ts`（第二次写入失败则撤销第一次）；`context.ts` 在 `onSaved` 期间屏蔽两份配置的变更回调，两次写入都成功后才统一 `applyPublic()`。新增 `tests/core/write-pair.test.ts` 4 条（含真实 JsonStore、settings.json 被改成无效 JSON）。**没覆盖**：进程在两次写入之间被杀的恢复（此时只有新 token 写入、托管开关未变，重启后若开关本来就开着会用新 token 连接——与任务显示的状态不一致，但不会断开已在托管的旧地址之外的东西；如需要事务日志请告知）。

### CR-008 · 中 · 隧道准备任务没有被停止，重启会并发使用同一个下载临时文件

- **位置**：`server/core/tunnel.ts:194–205`、`server/core/tunnel.ts:353–356`、`server/core/tunnel.ts:390–410`、`server/core/tunnel.ts:422–426`。
- **问题描述**：begin 丢弃 run 的 Promise；teardown 仅增加 gen、停止子进程，未取消或等待 prepare。gen 检查发生在准备任务完成之后，不能停止实际下载及文件操作。更换 token 或关闭后再次开启时，两次 prepare 可并发操作同一 `${dest}.${process.pid}.dl`，各自的 finally 又会删除同一路径。
- **触发场景**：本机没有 cloudflared，正在下载时更换 token，或快速关闭再开启；旧下载仍在进行，新下载已经开始。关闭程序时也无法通过 TunnelManager.shutdown 确认下载已清理。
- **证据**：注入可暂停的纯内存 prepare：token A → token B 后观察到 **2 个同时进行的准备任务**；调用 shutdown 返回后，两者仍在等待。没有启动真实 cloudflared或写入文件。现有「准备期间关闭」测试只验证不 spawn，未验证 prepare 被取消／等待。
- **建议修改**：保存运行任务句柄，传递 AbortSignal 到 HTTP 和 pipeline；关闭时取消并等待清理，重新开启时串行化安装，或使用每次操作唯一临时路径。补充重叠下载、旧任务 finally 与新任务冲突、shutdown 等待清理的测试。
- **处理结果**：**已修复**。核实成立：prepare 没有句柄也不可取消。`TunnelManager` 保存运行中的 prepare 及 AbortController，teardown（换 token / 关闭 / shutdown）先取消并等待其结束；下载使用 `net.signal`；临时文件名每次调用唯一。新增 2 条测试（换 token 时旧任务被取消并先结束、同一时间只有 1 个准备任务；shutdown 等待准备完成）；原「准备期间关闭」测试因此改为在稍后放行 prepare。注：自定义 prepare 若不响应 signal，关闭会等它结束（真实实现受下面 CR-009 的时限约束）。

### CR-009 · 中 · 更新 HTTP 没有应用级超时，网络停滞不会落入失败状态

- **位置**：`server/core/llamacpp.ts:60–64`、`server/core/llamacpp.ts:120–126`；新更新调用链：`server/core/updater.ts:193–203`。
- **问题描述**：获取 release、pointer 和下载 body 均未设置 timeout／AbortSignal。连接或响应 body 持续停滞时，更新器可能一直保持 working，不能按计划「网络失败只记事件」结束；首次无运行版本时会持续无法加载。context.shutdown 也没有取消或等待更新器，退出可能直接截断下载。该 helper 原有，但阶段 4 新的后台更新及隧道下载继续依赖它，影响本阶段生命周期要求。
- **触发场景**：代理／网络设备接受连接却不完成响应，或大文件下载停止输出而保持连接。
- **证据**：静态调用链确认无应用层总时限、无 body 停滞时限、无更新器 shutdown 接口；现有网络测试是立即抛异常／返回错误，未覆盖永不完成的 fetch／body。本次未等待真实网络停滞。
- **建议修改**：设置可区分 release 请求与大文件下载的合理时限／停滞时限，并支持关机取消；在 finally 中关闭流、清理临时文件，报告 error 且保留旧版本。补充挂起响应头、挂起 body、关机取消的测试。
- **处理结果**：**已修复**。核实成立：更新 / 下载 HTTP 无时限、无取消。`llamacpp.ts` 新增 `NetOptions`：小请求（release、pointer，含读取 body）整体 30 秒；下载等待响应 30 秒、之后相邻两块数据间隔 30 秒（大文件不限总时长）；`signal` 用于关机。`Updater.stop()` 取消并等待检查结束，`context.shutdown` 调用；隧道的 cloudflared 下载同样使用。新增 4 条测试（挂起响应头、挂起 body、下载停滞无半成品、stop 取消）。注：zip 解压仍是外部进程，取消后要等它结束再清理。

### CR-010 · 中 · 断开连接日志会增加隧道连接数

- **位置**：`server/core/tunnel.ts:490–495`。
- **问题描述**：`/Registered tunnel connection/i` 也匹配 `Unregistered tunnel connection`，而 registered 分支在前。因此断开日志进入 `connections++`，后面的递减分支永远不会处理这种行；断网后可以继续显示 connected，计数不断膨胀。
- **触发场景**：cloudflared输出一条或多条 Unregistered 日志，随后内部重连但进程不退出。
- **证据**：对 `INF Unregistered tunnel connection connIndex=0` 执行代码中的两个正则，二者均为 true，实际选择 **increment**。现有假进程没有连接注销场景。
- **建议修改**：使用完整消息边界或先匹配注销，最好按 connIndex 维护连接集合，避免重复注册／注销使计数失真。补充注册→注销→全部断开→重新注册的状态测试。
- **处理结果**：**已修复**。核实成立：`/Registered tunnel connection/i` 会匹配 `Unregistered…`。改为先匹配 Unregistered 并加词边界，并按 `connIndex` 维护连接集合（重复注册 / 注销不会使计数失真）。新增假进程 `flap` 模式和测试（注册 → 注销 → 全部断开 → 重新注册）。

### CR-011 · 中 · PID 登记失败时缺少退出清理，留下失效 child 引用

- **位置**：`server/core/tunnel.ts:459–469`、`server/core/tunnel.ts:506–527`；重试入口：`server/core/tunnel.ts:346`。
- **问题描述**：设置 this.child 后调用 registry.add；失败时直接 return。childDone 与 exit／close 清理监听器此时尚未安装。killTree 即使成功，this.child 也不会清空；修复登记文件后手动 retry 因 this.child 非空而直接返回。自动重试又可以覆盖这个未清理对象，生命周期行为不一致。
- **触发场景**：pids.json 写入／备份目录权限或磁盘故障使首次登记失败，用户修复后立即点击重试。
- **证据**：与 runner 的 register-failed 路径比较，隧道这条提前返回路径缺失退出收尾。runner 已有登记失败回归测试；TunnelManager 没有对应测试。本次未制造真实磁盘权限故障。
- **建议修改**：在任何可能失败的登记前建立统一退出与等待逻辑；登记失败时终止并等待进程，将引用及流收尾后再安排重试。补上登记失败→修复→手动重试成功，以及同时 shutdown 的测试。
- **处理结果**：**已修复**。核实成立：`registry.add` 失败时已设置 `this.child`，且无退出清理。现在先登记再保存 child；登记失败时杀进程树（记录 `killing`，下一次启动 / teardown 先等它结束），`this.child` 保持为空，手动重试和自动重试都能直接启动。新增测试（登记失败 → 进程被结束 → 修复后手动重试成功、pids.json 只有一条）。

### CR-012 · 中 · 引导恢复到正在执行的 Cloudflare 任务后不会取得最终状态

- **位置**：`app/composables/useCloudflareSetup.ts:37–42`、`app/composables/useCloudflareSetup.ts:89–99`；后端通知：`server/service/context.ts:293–298`。
- **问题描述**：job 只在 loadInfo 或本页发起的 apply／retry 返回后更新。后端 onChange 仅写控制台，不进入 LiveHub 快照。刷新／新标签页读到 running 后，原请求虽继续执行，该页面的 job 仍永久停在 running；PublicCfRun 只对 failed／done 提供恢复或下一步按钮。正在运行时的逐步进度同样只在最终响应后才能看到。
- **触发场景**：在一键配置的慢请求期间刷新或打开另一标签页，loadInfo 拿到 running。原任务稍后成功或失败，但当前页面没有相应变化。
- **证据**：已追踪所有 job.value 赋值与服务端 onChange；StateDoc 及 context 的 live snapshot 均不包含 Cloudflare job。现有核心测试验证后端任务，不覆盖刷新时的前后端恢复。该浏览器场景本次未运行。
- **建议修改**：把脱敏 job 状态／步骤加入 useLive 的统一数据流，并在连接／重连时发送当前状态；恢复引导时先取得当前 job，再决定是否重新预览。补充运行中刷新、另一标签页、最终失败恢复的集成测试。
- **处理结果**：**已修复**。核实成立：job 不在 live 快照里。`StateDoc.cloudflare`（脱敏的 job 视图）加入快照，`CloudflareSetup.onChange` 触发 `live.notify()`；`useCloudflareSetup` 监听 `useLive()` 的该字段，刷新 / 另一标签页 / 运行中的逐步进度都会更新。新增 live 测试（快照携带 job、变化时推送）。**没运行**浏览器里的「运行中刷新」场景（只有单测）。

### CR-013 · 低 · 已提交的交接包含用户真实隧道名

- **位置**：`docs/handoff.md:51`（阶段 4 新增内容）。
- **问题描述**：该行明确描述真实运行数据中的隧道，并记录其真实名称，违反 AGENTS.md「代码、测试、文档、提交信息不能出现个人域名、隧道名等」的公开仓库规则。本报告不复述该名称。
- **触发场景**：当前阶段 4 提交推送到公开仓库时已经发生；无需异常操作。
- **证据**：该行位于阶段 4 的 handoff 增量中。`git ls-files data` 无输出，没有发现 data 文件被跟踪；此意见仅指已确认的交接信息，不宣称仓库中存在真实 key 泄漏。
- **建议修改**：用「旧隧道／目标隧道」等泛化描述替换，并检查阶段 4 的文档增量。是否清理已推送历史由用户决定；本次未修改或重写任何历史。
- **处理结果**：**已修复（仅工作区）**。核实成立，且同文件第 41 行（4-5 条目）还有另一处真实隧道名和一个机器名。已全部改为泛化描述；已再检索仓库其余文档，没有别的出现。**已推送的历史**里仍包含这些文字：是否改写历史由用户决定，本次没有动。

## 实际验证与限制

| 实际执行 | 结果 |
|---|---|
| `git status --short`、`git log`、`git diff --name-status aef4cda..HEAD`、相关增量与调用链读取 | 审查开始及报告写入前工作区干净；范围如上 |
| `bun test` | Bun 1.3.14：**524 pass、8 skip、0 fail**，532 条、37 个文件，41.58 秒。8 条 hook 测试因当前 PATH 没有 sh 被跳过 |
| 临时在本次 PowerShell 进程的 PATH 加入已安装 Git 的 usr/bin，再执行 `bun test tests/platform/pre-commit.test.ts` | **8 pass、0 fail**，7.21 秒；PATH 已恢复，没有修改持久配置 |
| `bun run -`，通过 stdin 执行纯内存 FakeCloudflare 复现 | CR-002：删除新隧道后 DNS 仍指向它；CR-005：重试静默覆盖变化；CR-006：响应丢失后留下孤立资源 |
| `bun run -`，纯内存 prepare／正则／ingress 复现 | CR-008：两个 prepare 重叠，shutdown 后仍未结束；CR-010：注销行选择增计分支；CR-004：宽泛规则移到路径规则之前 |
| `bun run -`，读取现有 hook、使用 Git POSIX shell 和合成 diff | CR-001：两类假 Cloudflare 凭据被放行，假 sk key 被拒绝。首次 helper 尝试因 shell PATH 找不到 grep 不能作为有效结果；修正 helper 的进程内 PATH 后，三组结果 stderr 均符合预期 |
| `bun run -`，临时 loopback Bun 服务：公网入口→实际 proxy→假流式上游，读取首块后关闭 PublicListener | **released=1、upstreamGone=true**，验证关闭公网入口中止在途流式请求；两个服务及定时器已在 finally 中关闭 |
| `git ls-files data`、`.gitignore` 与 hook 配置读取 | 无跟踪的 data 文件；data 忽略规则存在；当前 hooksPath 为 scripts |
| `git diff --check`、报告内容检查、最终 `git status --short` | 通过；报告另行检查为 13 个唯一编号、无行尾空白、无个人绝对路径；工作区只有本报告新增 |

没有执行 `bun run build`、`bun run typecheck`：本次没有代码改动，为遵守只审查约束，未运行可能生成／更新构建和 Nuxt 文件的命令。没有启动真实模型、占用 GPU、下载安装真实运行版本、改变用户 Cloudflare 账号、读取 data/secrets.json、检查用户真实运行日志、浏览器真机验收，或重新验证历史交接声称的冒烟结果。

现有调度／转发回归覆盖同目标共享加载、draining、超时中断、等待期间与流式阶段断开、管理目标排在旧请求后，以及进程树／残留清理；本次这些测试通过。阶段 4 的公网路径隔离、有效／无效／吊销 key、来源伪造、防止 Authorization 转发也通过现有测试。本次未发现这些规则在阶段 4 新增路径中的明确绕过。更新器的 SHA-256、半成品隔离、使用中版本保护、下载中回退等现有测试通过，但并不覆盖 CR-009 的停滞／关机路径。

修复优先处理凭据 guard 和会破坏既有地址／配置的 CR-002～CR-007，再闭合后台任务与状态恢复。上述回归测试建议均未在本次新增或修改。
