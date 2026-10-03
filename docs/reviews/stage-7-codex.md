# llama-web 阶段 7 代码审查

审查日期：2026-10-03。审查对象：`main`，HEAD `f1f5f9b0f4aa014cab55030573186da9875f2372`。

结论：**rework required**。发现两项已确认问题（中 1、低 1），另有一项计划契约差异待确认。没有发现本次改动直接削弱公网鉴权的证据。测试通过不能替代下列边界问题和未执行的真机验收。

本次只新增本报告；没有修改代码、测试、计划、交接或配置，没有提交。

## 范围和依据

先读取了提示路由规则、`AGENTS.md`、`docs/plan.html`（核心行为规则、关键决定 31/32、阶段 7 任务和验收标准）、`docs/claude-guide.html`、最新 `docs/handoff.md`，按 code-review 技能进行审查。

通过 `git log` 确定的阶段 7 范围为 `2466dc5..f1f5f9b`，共两次提交：

| 提交 | 内容 |
| --- | --- |
| `a5f2c0a2511bcff29fbd7b94542a437791dda28f` | 7-0：阶段 7 规划、决定 31、指南及交接 |
| `f1f5f9b0f4aa014cab55030573186da9875f2372` | 7-1：临时隧道核心、协议选择、settings v5 |

范围内有 15 个文件，565 行新增、64 行删除。完整阅读实现和测试差异，并追踪相关的公网监听、鉴权、转发、调度、配置存储、PID 登记和退出接线。7-2 尚未实现：向导入口、地址显示、协议选择界面及收尾验收均在计划中明确未勾选，不把这些待办列为 7-1 的实现缺陷。

## 审查意见

### S7-001 · 中 · 临时模式仍受父进程的 cloudflared 环境配置影响

- **位置**：`server/core/tunnel.ts:565`、`server/core/tunnel.ts:566`；相关测试 `tests/core/tunnel.test.ts:274`。
- **问题描述**：`spawnChild()` 复制整个 `process.env`，只删除精确拼写的 `TUNNEL_TOKEN`。空 YAML 只能隔离默认配置文件，不能隔离环境变量。`TUNNEL_NAME` 仍会传入 cloudflared；官方 2026.5.0 实现先检查 name 并进入命名隧道分支，随后才判断 Quick Tunnel。因而即使设置和参数是 quick，也可能没有临时地址，甚至进入已有账号的隧道创建或复用流程。这与决定 31 的免账号、临时模式约定不一致。[cloudflared 2026.5.0 官方源码](https://github.com/cloudflare/cloudflared/blob/2026.5.0/cmd/cloudflared/tunnel/cmd.go#L229)
- **触发场景**：用户曾为其他 cloudflared 用途设置 `TUNNEL_NAME`，再从继承该环境的终端或桌面环境启动 llama-web，选择 quick。缺少账号凭据时可能启动失败并持续重试；有凭据时可能走命名隧道流程。此结果依据官方分支顺序推断，本轮没有执行真实账号或联网隧道操作。
- **附带确认的问题**：Windows 环境变量不区分大小写，而展开后的普通 JavaScript 对象区分大小写。父环境若保留 `tunnel_token`，`delete env.TUNNEL_TOKEN` 无法删除它，quick 子进程仍能读取到 token。这个泄漏到子进程环境的事实已在本机复现；没有证据证明它已进一步进入日志或被 Quick Tunnel 使用，不作此断言。
- **验证证据**：对实际 `spawnChild()` 注入捕获型 spawn（不启动隧道、不写文件），得到 `inheritedName: true` 和 `inheritedTokenKeys: ["tunnel_token"]`。另用独立 Windows Bun 子进程验证，只有小写键时 `process.env.TUNNEL_TOKEN` 仍可读取到值。全部使用构造占位数据，没有读取真实 secrets。
- **建议修改**：构造明确受控的 cloudflared 环境，移除会选择隧道模式或凭据的继承变量，至少包含 `TUNNEL_NAME` 和所有大小写变体的 `TUNNEL_TOKEN`；核对其他能改变 origin/模式的变量，避免把环境中的配置作为隐式输入。保留程序运行及正常代理所需的系统环境；token 模式只注入当前保存的 token。
- **缺失测试**：现有 quick 测试只设置大写 `TUNNEL_TOKEN`。补充 Windows 大小写变体、继承 `TUNNEL_NAME` 的回归测试，直接检查 spawn 获得的环境；验证 quick 不携带凭据且 token 模式使用明确保存的 token。
- **处理结果（2026-10-03，Opus 5.5）：已修复。** 成立。新增纯函数 `cloudflaredEnv(base, token)`：去掉所有 `TUNNEL_*` 变量（键名转大写比较，覆盖 `tunnel_token` 等大小写变体），只在 token 模式写回已保存的 token；两种模式都用它（`TUNNEL_LOGLEVEL`、`TUNNEL_HOSTNAME` 等同样会改变 cloudflared 行为或我们解析的输出）。HTTPS_PROXY 等系统变量保留。测试：`cloudflaredEnv` 单测覆盖 TUNNEL_NAME / 小写 token / 混合大小写 / 日志级别；quick 管理器测试注入 `TUNNEL_NAME` 和 `TUNNEL_TOKEN`，捕获实际 spawn 的 env，断言没有任何 `TUNNEL_*` 键。

### S7-002 · 低 · 地址中的单词被误判为日志错误级别

- **位置**：`server/core/tunnel.ts:310`；地址消费处 `server/core/tunnel.ts:627`；相关测试 `tests/core/tunnel.test.ts:235`。
- **问题描述**：`quickTunnelHost()` 在整行搜索 `ERR`、`WRN`、`error`，没有限定日志级别字段。连字符形成单词边界，合法地址标签包含这些单词时，即使该行日志级别是 `INF`，也会返回 null。连接仍可能显示 connected，但 `quickHost` 为空，临时模式的地址列表和自检目标均为空。
- **触发场景**：输出横幅含 `https://some-error-words.trycloudflare.com`，或同样包含独立 `err` / `wrn` 片段的标签。解析失败已确认；**待确认** Cloudflare 当前随机词表是否实际生成这些词，因此不把它描述为已发生的真实隧道故障。
- **验证证据**：`bun --eval` 调用实际解析函数：普通标签返回 hostname；`some-error-words`、`some-err-words`、`some-wrn-words` 三种 `INF` 横幅均返回 null。
- **建议修改**：只检查结构化日志前缀中的级别，或严格解析地址横幅；不要把 hostname 内的词当作日志级别。保留对实际 ERR/WRN 行、API 主机、越界后缀的拒绝。
- **缺失测试**：加入上述合法 hostname 的正例，并与真正 ERR/WRN 前缀的反例配对。当前测试只覆盖普通标签以及错误行，未覆盖这两类内容重叠的情况。
- **处理结果（2026-10-03，Opus 5.5）：已修复。** 成立。级别只看日志前缀（行首或时间戳后的 `WRN` / `ERR` / `FTL` / `PNC`）和 `error=` 字段，不再在整行搜单词；地址后紧跟 `/` 的（请求路径，不是横幅）也不算。测试：`some-error-words`、`some-err-words`、`some-wrn-words`、`ftl-warning-x` 四个正例；`FTL` 前缀、无时间戳的 `ERR` 行、`error="…"` 字段、`INF` 行里的 `https://abc.trycloudflare.com/tunnel` 四个新反例，原有反例保留。

### S7-003 · 低 · 待确认：token 模式的端口变更行为与 7-1 计划表述不一致

- **位置**：`server/core/tunnel.ts:372`、`server/core/tunnel.ts:478`；`tests/core/tunnel.test.ts:487`；计划 `docs/plan.html:617`。
- **问题描述**：已勾选的 7-1 任务写明“模式 / 端口变化会重启”，但 `launchKey()` 在 token 模式不包含 port；现有测试明确断言换端口后仍只启动一次。代码注释解释为 token 模式的端口由远端配置决定，这一行为是沿用旧实现，不能直接称为阶段 7 新引入的回归。
- **触发场景**：token 隧道已连接，只把公网入口端口从 8080 改为 8099。公网监听会换端口，TunnelManager 仍保留原 Launch、PID 记录中的端口以及输出解析所捕获的旧 port。若随后把远端 ingress 改到新端口，`ingressHostnames()` 仍按旧端口筛选，地址元数据可能不能正确更新。重启本身也不能代替修改远端 ingress。
- **建议修改**：先确认计划是否只要求 quick 模式在端口变化时重启。若适用于两种模式，应让 token 模式也按端口变更重新接线，并保留远端 ingress 配置提醒；若只适用于 quick，应明确修订计划文字，并解决或说明 token 模式的旧端口元数据问题。未经确认不应擅自改变既有行为规则。
- **验证和测试**：整个测试套件已通过，包括上述“不重启”断言；这证明当前实现行为，不证明它符合计划。后续应补“token 模式换端口后接收新 ingress 配置”的测试，核对 hostname 和 PID 元数据。
- **处理结果（2026-10-03，Opus 5.5）：计划文字澄清 + 修复旧端口元数据，行为规则不变。** 计划里这句话写在「TunnelManager 临时模式」那一条里，指临时模式；token 模式换端口不重启是 7-1 之前就有、有测试固定的既有行为（端口在远端 ingress 里，重启也解决不了），所以不改行为，只把 plan 7-1 该句改为「临时模式端口变化会重启（token 模式的端口在远端配置里，不重启）」。成立的部分是旧端口元数据：现在 token 模式换端口时更新当前 Launch 的端口，用最近一次收到的配置行按新端口重新筛选 hostnames，之后收到的新配置也按新端口筛选。测试：token 模式 8080 → 3000 → 8099 → 8080，hostnames 依次变化，进程只启动一次。PID 记录里的 port 只是元数据（残留清理按可执行文件路径和进程身份判断），没有改。如果希望 token 模式换端口也重启，需要用户决定。

## 重点检查结果

| 检查方向 | 结果与边界 |
| --- | --- |
| 排队、draining、客户端断开 | 阶段 7 未改 scheduler/proxy。追踪到等待请求取消、在途 lease 释放和 drain 超时中止路径；现有相关测试通过。没有发现由此次差异引入的新缺陷。未验证真实 Cloudflare 断连时信号传播的时延。 |
| 隧道并发、时序 | apply/retry 通过队列协调，generation 阻止旧准备任务启动；teardown 取消准备、等待清理、清除退避定时器。quick 模式/端口、两种模式的协议切换和地址清空都有测试。环境隔离问题见 S7-001。 |
| 进程清理 | 生产路径使用 runtime 下的 executable，PID 登记与身份探测沿用已有实现；主动停止调用 killTree。quick 子进程树停止、关闭公网后 PID 清空、异常退出后新地址测试通过。本轮没有真实 cloudflared 硬杀恢复验收。 |
| 文件、定时器、流等资源 | 空配置是计划要求保留的运行资产；正常替换及 rename 失败有清理路径。下载取消、等待准备完成、重试定时器取消沿用已有逻辑。本轮未注入磁盘写入中途失败或系统杀树失败，不能据此保证所有 OS 故障路径。 |
| 错误处理 | quick 准备/启动异常进入已有错误与退避路径；日志先经过 redact。地址解析失败缺少可靠输出的问题见 S7-002。shutdown 后 status 保持 connected 是交接已披露的旧行为，本轮未重复列为新缺陷。 |
| 公网鉴权 | `PUBLIC_HOST` 固定为 127.0.0.1；非 `/v1/*` 路径先拒绝；有效且未吊销的 Bearer key 才能转发；keyName 由进程内参数传递，Authorization 不转给上游。相关函数及真实本地 socket 测试通过。本次模式改动未绕过这些边界。 |
| 配置兼容 | v4→v5 默认 token/http2；低版本迁移链、normalize 回落和管理接口校验测试通过。迁移仍走已有 JsonStore 备份/原子保存机制。默认协议变化是决定 32 的明确要求，不作为“旧配置行为不变”的缺陷。 |
| 敏感信息 | 本轮仅检查阶段 7 差异、相关夹具及提交信息；未发现新增真实 key、个人模型路径、隧道名或私人域名；`git ls-files data` 无输出。未读取真实 `data/secrets.json`，未审计全部历史。子进程继承凭据的边界问题见 S7-001。 |

## 验证记录

实际运行：

1. `git status --short`：开始时工作区干净；报告写入前仍干净。
2. `git log -35 --oneline --decorate`、`git log 2466dc5..HEAD`、`git diff --stat 2466dc5..HEAD`、相关 `git diff` / `git show`：定位范围并核对差异。
3. 在命令进程 PATH 加入已安装 Git 的 bin 后运行 `bun test`。首次调用没有保留完整结束输出，随后重跑并收集结尾：**693 pass、0 fail、3393 expect() calls、47 文件、95.42 秒**。测试使用仓库已有构造夹具，没有运行真实模型或隧道。
4. 分别运行以下四条只读类型检查，均退出 0、无诊断：

   ```text
   node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p .nuxt/tsconfig.server.json
   node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p .nuxt/tsconfig.app.json
   node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p .nuxt/tsconfig.shared.json
   node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --incremental false -p .nuxt/tsconfig.node.json
   ```

   使用现有 `.nuxt` 配置，不生成产物或增量缓存。**未运行 `bun run typecheck`**，避免 Nuxt prepare 更新文件；不能把上述结果称为重新生成 Nuxt 类型后的标准命令验收。
5. 两次 `bun --eval` 边界探针：验证实际 hostname 解析、Windows 子进程环境读取以及实际 spawnChild 的环境传递，结果见 S7-001/002。不落脚本、不启动公网监听或隧道，变量只在探针进程内构造和恢复。
6. 只读核对 cloudflared 官方 2026.5.0 源码，确认环境变量对应关系及模式分支顺序。
7. `git diff --check` 通过，只有 CRLF 转换提示；结束时未见本轮 Bun 测试进程。

工作区边界：测试和类型检查之后、写报告之前的 `git status --short` 仍为空。写完报告后的最终检查发现其他并行改动：`app/components/SettingsDirs.vue`、`app/pages/models.vue`、`app/pages/setup.vue`、`i18n/zh-CN.ts`、`server/core/config.ts`、`server/core/live.ts`、`server/core/models-admin.ts`，以及新增的目录选择 composable、fs API、模型 setup API 和 folder-picker 模块。这些不是本轮操作产生的，未修改、撤销或纳入审查。上述测试结果对应并行改动出现前的工作区，不能替这些新改动作验证背书；本报告的范围和行号以所列 HEAD 提交为准。

未运行：build、浏览器/安装包验证、真实模型/GPU、真实 Cloudflare 隧道、真实账号操作、从零下载、卸载及硬杀恢复。交接记录中的真实 llama-server 隧道测试是此前会话的结果，本轮没有重复验证。

## 阶段验收仍待完成的部分

7-2 尚未实施，阶段 7 不能整体验收完成。除处理以上意见外，应按计划完成向导与地址显示，核对临时模式使用 quickHost，然后在真实 quick 隧道→llama-web 公网入口→proxy 的完整链路验证无 key/吊销 key 的 401、非 `/v1/*` 的 404、带 key 的非流式/流式请求，以及停止/退出后 PID 与进程清理。

当前真机交接使用 llama-server 自己的 `--api-key`，没有经过 llama-web 公网入口。建议在该完整链路中加入等待加载时断开、生成中断开、在途请求存在时切换模型或停止隧道，核对排队等待者与 inflight 回收；这些是后续验收建议，本轮没有把未运行的情况断言成已存在缺陷。
