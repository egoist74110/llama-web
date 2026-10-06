# 阶段 9 闭环复审 · 2026-10-06 · GPT r2

## 总体结论与审查基线

**结论：rework required，当前不能通过阶段 9 关口。** 原 CR-010～CR-017 中，5 项已修好，CR-012 修了但存在新的分配边界问题，CR-013、CR-016 尚未完整修好。本轮新增确认 3 项 major、1 项 minor：CR-018～CR-021。没有确认的 critical。

**阻塞项：** CR-013 剩余的内部管理启动确认缺口，CR-018 的等待者变化竞态，CR-019 的逐卡分配边界错误，CR-020 的旧实测记录错误复用。CR-016 残留文案和 CR-021 拒绝反馈也应补齐。row/tensor 的多卡保护验收另有范围限制，见“原待确认事项”；完整测试通过不能替代这些独立复现或真机关口。

**基线与用户描述不同：** 本轮开始时 HEAD 仍为 `c69b138`，`git diff c69b138..HEAD` 为空。修复实际位于未提交工作区：24 个已跟踪文件有差异，另有新 model-facts / memory-checks-composable 测试和原审查报告。本轮检查的是 `git diff c69b138` 的工作区内容及这两个新测试，不声称存在新的修复提交。已有文件均保留；只新增本文，没有修改实现/测试，没有提交或 stash。

已读取 AGENTS.md、原报告、最新交接和计划的多模型并行规则，并沿改动调用链检查。交接只用来定位，没有把作者的验证结果当成本轮证据。没有读取真实 `data/secrets.json`；context 复现使用合成配置和隔离临时目录。以下模型、设备、内存输入均为构造数据；内存单位为 MiB。

| 原编号 | 闭环状态 | 核心证据 |
| --- | --- | --- |
| CR-010 | **已修好** | 真实读三片并合并七个 tensor，总计 114688 字节；后片中的层、输出和输出 norm 均计入。后片改为损坏文件后，`sharded=true` 且估算带 `layout-unknown`。原先放大第一片的逻辑已删除。 |
| CR-011 | **已修好（所列 offload 开关契约）** | 最终 argv 的正/反开关按先后覆盖；extraArgs 覆盖表单的三个组合独立运行正确。2048 MiB 视觉文件关闭 offload 后，主机 mmproj=2867.2，设备为 0，结果从 ok 改为 nofit；Mac 合并池开/关均只计一次。 |
| CR-012 | **修了但引入新问题：CR-019** | 原四层双卡案例和 ngl=0/1/2/5/999 均按新公式正确，输出参与分配；但 JavaScript 数值运算与上游 float32 累计阈值不同，三卡比例边界仍会把大层算到错卡。row/tensor 不能由 layer 修复推导为已验证。 |
| CR-013 | **没修好（部分路径修复）** | start/retry/setup 已把明确的 true/false 传给最终调度；普通未确认 risky/unknown 被挡。但内部 restart/switch/startLast 的 undefined 仍被当作放行；另有 CR-018 等待者竞态和 CR-021 前端反馈遗漏。 |
| CR-014 | **已修好** | 原在线集合变化用例通过；独立三次 force 只合并成一次补查，旧结果不发布，补查失败后没有第三次请求或无限重试。 |
| CR-015 | **已修好** | Windows 继承默认 mlock 的正向断言保留，随后清空全局 extraArgs 才做无 mlock 对照，并在 finally 恢复。完整测试通过，产品 mlock 逻辑未改。 |
| CR-016 | **没修好（字段及原主要文案已修）** | 实际 service 的 darwin 分支返回 `acceleratedLayers=999`，没有 GPU 参数字段；主要分组和 unknown 文案改好了。但 Mac 的 watchdog API 拒绝仍返回“显存 / 内存”。 |
| CR-017 | **已修好（原同毫秒问题）** | 真实 Scheduler/routing 固定时间，A→B→A 选择 A；同名模型、重启到另一方案后仍选择正确的 modelId/profile，序号继续增加。 |

## 新发现（按严重程度排序）

### CR-018 · major · admission 等待期间的请求取消/确认加入不会刷新最终授权判断

- **位置：** `server/core/scheduler.ts:551`～`554`、`564`～`570`；请求取消改变等待者的入口为 `acquire()`。
- **一句话问题：** `byRequest` 和 `unconfirmed` 在异步 admission 之前计算一次，最后用旧等待者集合决定能否加载，而等待者可以在 await 期间加入或取消。
- **失败场景一：** 请求先触发加载，挂起 admission → 未确认手动 start 加入同一目标 → 请求 AbortSignal 取消 → admission 返回 risky。此时只剩 `confirmed:false` 的手动等待者，旧 `byRequest=true/unconfirmed=false` 却允许启动。
- **失败场景二：** 未确认手动 start 先入队，挂起 admission → `confirmed:true` 的 start 加入同一目标 → admission 返回 risky。旧 `unconfirmed=true` 拒绝了包括已经确认的调用在内的全部等待者。
- **独立复现：** 使用真实 Scheduler、可控 admission Promise、假 ModelProcess；没有起真实子进程。分别执行上述两个顺序，实际结果：

  ```json
  {"case":"requestLeaves","launches":1,"state":"ready"}
  {"case":"confirmedJoins","launches":0,"state":"stopped","code":"no-room","reason":"unconfirmed"}
  ```

- **建议修法：** 每次 admission 返回后、每次腾空间后，基于当时仍有效的 waiters 重新判断来源和确认；检查与使用判断之间不能再让出执行权。明确共享加载中“某个有效请求/已确认管理调用允许加载”的规则，并补加入、取消及有确认者的并发测试。
- **是否已复现：** **已复现**，两个顺序均正常退出并关闭 Scheduler。HTTP/UI 并发场景 **未运行**。nofit/limit 仍会被硬拦，这不是强行绕过 nofit 的证据。
- **与原问题的关系：** 修复 CR-013 新增了确认条件，但没有将它纳入等待者变化的并发边界。

### CR-019 · major · 新累计阈值用 double 运算，在上游 float32 边界仍会少算一张卡的大层

- **位置：** `server/core/memory-estimate.ts:236`～`242`；`server/core/model-check.ts` 的 sharesOf/deviceInputs 先做了一次比例归一化。
- **一句话问题：** JavaScript 对归一化份额再累加时的 double 误差，与 llama.cpp 对原始份额累计后进行 float32 归一化的边界不同，严格 `>` 比较可把边界层算到前一张卡。
- **失败场景：** 九个重复层、全 offload（act=10）、三卡 `tensorSplit=1,2,7`。service 份额为 `[0.1,0.2,0.7]`；JavaScript 的 `0.1+0.2` 大于 `3/10`，把第 3 层放第二张卡；上游 float32 的两个阈值相等，`upper_bound` 把它放第三张卡。
- **独立复现：** 调用真实 `assignLayers(9,999,[0.1,0.2,0.7])`，与按上游各步骤使用 `Math.fround` 的累计阈值比较：

  ```json
  {"js":[0,1,1,1,2,2,2,2,2],"upstream":[0,1,1,2,2,2,2,2,2]}
  ```

  再把第 3 层权重设为 1000 MiB、其余层各 1 MiB，第三张卡预算 1000、前两张卡各 10000，embedding/output 各 1，ctx=1024、parallel=1：原估算器输出 `ok`，第三卡需求 533.75；仅纠正这层权重归属就至少为 1533.75，已超过预算，尚未计它额外的 KV。
- **上游依据：** 本轮查阅 `ggml-org/llama.cpp` 的 `b11146`、`src/llama-model.cpp:1428`～`1445`：split 使用 float 累计/归一化，层的位置也转 float 再 upper_bound。上述对照执行的是该数值过程；不是假设双卡占用已经实测。
- **建议修法：** 保留并使用原始比例，匹配上游 float32 的累加、归一化及阈值转换顺序；不要用随意 epsilon 改变边界归属。覆盖三卡十进制份额、零份额和精确边界，并对输出层使用同一规则。
- **是否已复现：** **已复现层归属及错误预算结论**；真实三卡加载/CUDA OOM **未运行**。
- **与原问题的关系：** 原 floor/余数公式已换掉；这是新公式没有精确匹配后端数值语义的问题。

### CR-020 · major · 实测记录未随运行时/模型文件失效，旧占用会把新的 nofit 改成 ok

- **位置：** `server/service/model-check.ts:89`～`95`；`server/core/vram-stats.ts:144`～`154`。
- **一句话问题：** 记录摘要只由模型 ID、方案、设备和 argv 形成，不含实际运行时或模型文件版本；旧实测替换总需求后，新的计算缓冲和固定开销没有下限保护。
- **失败场景：** 同一方案先有旧实测 → 换成另一个运行时，argv 不变 → 更换同路径模型内容，保持命令参数不变，但新的架构信息使计算缓冲增大。读取 GGUF 的缓存已正确失效，实测记录仍命中，并覆盖新需求。
- **独立复现：** 隔离目录中运行真实 getContext/checkProfile/VramStats；两个合成 custom runtime 仅供预览，不执行它们。先为四层小模型记录设备 500、主机 20，再把方案运行时从 A 改 B；随后把同路径 GGUF 的 feedForwardLength 从 512 改 131072。当前设备可用 700，真实 service 和当前公式结果：

  ```json
  {"case":"runtimeReuse","sameSummary":true,"basis":"measured"}
  {"case":"fileReuse","sameSummary":true,"actualCheck":"ok","basis":"measured","device":500,"currentFormula":"nofit","formulaDevice":3089.640625}
  ```

- **证据解释：** 本轮没有声称上述合成头可以在 llama.cpp 运行；复现证明了“不同文件/运行时的记录被当成同一启动形态”及它对判断的实际影响。确知权重/KV 的下限不会保护已被历史总值覆盖的新增 compute/fixed。
- **建议修法：** 摘要加入解析后的运行时身份/版本及主模型全部分片、视觉/草稿文件的可靠版本信息；这些信息也可先做哈希，落盘仍不存路径或名称。文件或运行时更换必须回到 formula/重新实测，并补旧记录迁移或自然失效测试。
- **是否已复现：** **已复现真实 service 的旧记录命中及 nofit→ok**；真实替换模型/不同 CUDA 构建的占用变化 **未运行**。
- **与原问题的关系：** 原报告“待确认”第 1 项，本轮升级为已确认问题；不是本次修复才引入。

### CR-021 · minor · 加载时新增 unconfirmed 拒绝没有进入启动反馈，用户得不到确认框或失败通知

- **位置：** `server/core/scheduler.ts:690` 的 `refuse()`；`server/core/live.ts:188`；`app/composables/useModelStartFeedback.ts:57`、`65`～`75`。
- **一句话问题：** 后台拒绝只发 no-room 事件，而启动反馈只处理 state；HTTP 已经成功返回，原 409 确认框分支不会执行。
- **失败场景：** start/setup 预检 ok、HTTP 返回 ok → 出队时变 risky、confirmed=false → 新逻辑发 `no-room/unconfirmed`，没有创建实例或 failed state。界面没有打开 guard/notice，pending attempt 也不清除；只有事件列表中的文字提示可能显示。
- **独立复现：** 执行原 useModelStartFeedback 函数体，使用真实 Vue 响应式/watch 和合成 useLive/useState：begin→accepted→写入对应 manual no-room/unconfirmed 事件，实际为 `pending=["a"]`、`notice=null`。服务器的 refuse/live 映射经代码核对，确实是这个事件类型。
- **建议修法：** 启动反馈处理与当前 attempt 匹配的 manual no-room，清除 pending，按实际 risky/unknown 打开确认框，或至少给出可操作的失败通知；考虑重连重放与实例未创建的 snapshot 收尾。为“预检 ok、出队未确认拒绝”补前后端接线用例。
- **是否已复现：** **已复现原 composable 逻辑**；真实浏览器/HTTP/SSE 完整交互 **未运行**。
- **与原问题的关系：** CR-013 修复新增了可拒绝的后台路径，但只补了事件文案，没有补启动反馈消费者。

## 原问题剩余缺口（保留原编号，不重复编号）

### CR-013：内部管理操作仍以 undefined 绕过风险确认

`ModelOps.startLast()`（`server/core/model-ops.ts:53`）和 `restart()`（`:76`）没有携带 confirmed。Scheduler 只在全部等待者明确为 false 时才认为未确认，undefined 不是“没有确认”，实际等价于放行。

`profile.post.ts` 切方案走 `ops.switchTo()`；profiles/files 的保存后重启走 `restartIfUp()`→restart。首次设置 start:true 的缺口已补，但这几条路径没有统一。对未知档位，保存确认本来就不弹，因此“点击保存并重启”不能证明用户看过并接受未知加载风险。切换方案也没有风险确认回答。

**独立复现：** 真实 ModelOps/Scheduler，旧方案以 ok 启动；探针改为 unknown，直接 `switchTo('a','new')` 并等待返回 work，得到 `newState=ready`、总 launch 次数 2。没有传任何风险确认。相同 restart 末尾调用也适用于保存后重启。HTTP 保存/切方案 **未运行**。

建议让内部启动显式表达来源和已接受的风险，而不是用可选字段的 undefined 隐式豁免；新配置/新方案不能自动继承旧方案的风险接受。作者的“内部操作不判断确认”取舍是真实实现状态，但没有消除原报告提出的加载确认缺口。若产品希望对此例外，需先明确改变行为规则。

**路由与请求核对：** start/retry/setup 的路由均传明确 true/false，ModelOps 转给 Scheduler waiter；正常不发生等待者变化时，最终 risky/unknown 拦截有效。请求的 risky 按计划可加载，unknown 旁有模型时仍走 no-room/腾空间，nofit 和 limit 始终硬拦；公网 `/v1` 没有另起加载入口，`/upstream` 仍只转 ready。没有发现 confirm:true 绕过 nofit/limit 的新路径。

**首次设置流程：** setup 先保存答案再 checkedStart，409 时 FirstStartDialog 会 cancel feedback、打开共享 StartGuard、关闭自身；风险确认后的普通 start 带 true。该预检 409 分支的接线完整，但预检之后才拒绝仍受 CR-021 影响。真实首次设置弹窗 **未运行**。

### CR-016：Mac watchdog 代理拒绝仍使用显存文案

`server/core/proxy.ts:193` 只为 unknown 切换 Mac 文案；`i18n/zh-CN.ts:1753` 的 watchdog 仍为“服务器的显存 / 内存不足……”。Mac 也运行系统内存看门狗；加载中的模型被它停止后，等待请求会收到这段 API 错误。

**独立复现：** 执行原 noRoomText 函数体，仅注入 darwin 平台和原 i18n，传 `reason=watchdog,pool=system`，确实返回上述“显存 / 内存”文本。真实 Mac 看门狗/API **未运行**。建议对 watchdog 分支也提供内存口径。

字段改名核对则通过：真实 service 返回没有 gpuLayers，含 acceleratedLayers；检查路由和保存检查返回复用该 DTO。前端 CheckDoc 的 params 为通用记录，本轮搜索未发现前端读取旧 `params.gpuLayers` 的调用方；core 内部 FinalParams 保留 argv 对应字段是合理的，历史报告引用也不应改写。新参数分组说明的 Mac 分支经模板/帮助函数核对存在，unknown 启动/代理说明也已切换。

## 其他修复边界核对

- **分片与视觉组合：** 三片的重复层各一份，embedding 一份、output 和 output_norm 一份；总 tensor 字节等于各字段和，未再乘文件比值。视觉文件是独立 `mmprojBytes` 项，没有合入主模型 tensor layout。损坏后片返回 partial 并带 layout-unknown；缺失后片的新增测试也通过。回退总量只能使用可 stat 的文件，不能把未找到的片大小凭空补齐；真实缺片启动另受文件预览/运行时约束，不把部分 layout 当完整布局。
- **视觉开关：** 合法正/反开关最后者胜出，canonical 的反向别名不破坏 extraArgs 优先级；本轮额外执行表单 off + extra on、表单 on + extra off、extra off 后 on，分别 host=false/true/false。Mac shared 池合并后，开/关都只有一份视觉占用。未扩大验证到其他视觉设备参数、环境变量覆盖或全部运行时版本。
- **层与输出边界：** 四层、双卡均分时 ngl=0 为全 host/output host；ngl=1 只有输出且在第一卡；ngl=2 最后一重复层在第一卡、输出在第二卡；ngl=5 与 999 均为重复层 `[0,0,0,1]`、输出第二卡。单卡和零份额从代码看不会额外分配给零份额卡，但多卡精确边界已有 CR-019，不能笼统宣称“极端比例已全覆盖”。
- **dirty 重算：** 在途多次 force 合并；旧 success/error 均不发布、不更新时间，finally 清理后补查。独立三次 force 得到两次 fetch，第二次失败后仍是两次、结果 null。持续真实在线变化会持续重算，这是外部输入驱动，未发现自行无限循环；稳定后能发布最新响应。浏览器卸载和持续抖动压力未运行。
- **mlock：** 用例没有删除 Windows 默认继承行为，而是新增正向断言，再构造无 mlock 对照。加载去除的产品代码未在本次差异中改变，多开关闭不执行 drop，符合规则。未声称实际 mlock/页锁定 OOM 已跑过。
- **useSeq：** 序号在 Scheduler 生命周期内单调，重载/停止删除旧实例但不重置 seq；新 Scheduler 从 0 起时没有旧在线实例混入。独立固定时间 A→B→A 的序号为 `[8,6]`、选 A；重启 A 到 q 并请求后为 `[6,11]`、选 A:q，同名显示名称不影响 modelId 定位。时间戳仍是主排序，系统时钟回拨不属于原同毫秒修复，未做操作系统时钟验证。

## 原待确认的四项：是否阻塞关口

| 项目 | 本轮判断 | 证据、要求及未运行项 |
| --- | --- | --- |
| 1. 实测失效条件 | **应阻塞** | 已从待确认升级为 CR-020，真实检查接线出现不同文件/运行时复用旧记录及 nofit→ok。需要修复并补回归。 |
| 2. 采样外部干扰 | **不单独作为已确认代码阻塞项；真机验收仍须验证** | 状态计数只能识别本服务变化，不能证明 OS used 差值全属于本模型。当前已有确知部分下限，但 compute/fixed 仍可能受误测影响。本轮未加入真实外部 GPU 负载，不能据猜测新报 OOM 缺陷。应在硬件关口校准噪声、说明测量可信度；不能称 WDDM 真机保护已验收。 |
| 3. row/tensor 用 layer 口径 | **应阻塞 row/tensor 多卡保护的验收/可靠放行；不等于 layer 模式无法单独验证** | 独立 checkLaunch 对 layer/row/tensor 得到完全相同 estimate 和三个 ok，FinalParams/EstimateParams 没有 splitMode。查阅 b11146 `src/llama-model.cpp:1076`～`1095`，row 使用 split buffer，不能仅凭层 owner 推导权重逐卡归属；tensor 也未建立对应资源模型。至少把这些组合标为无法可靠估计并明确保护范围，或实现并实测相应模型。真实逐卡占用/OOM 未运行，未把尚未测出的数值写成已复现缺陷。 |
| 4. 重新检查探针新鲜度 | **不单独阻塞最终加载拦截，但展示承诺需修正** | 独立 DeviceProbe 模拟：0 秒空闲 1000，15.001 秒真实改为 100，普通 list 仍返回 1000，refresh 返回 100。ProfileForm 和共享检查未传 fresh，确实可在强制 UI 重算时沿用一分钟缓存；dirty 修复不会让探针变新。最终 admitTarget 传 fresh:true，故没有据此证明硬拦截绕过。新检查正在进行时的 refresh 去重及真实探针耗时另未验证。 |

## 默认单开与配置兼容

本次差异没有修改 `server/core/config.ts`、settings 版本或迁移：仍为版本 10，multiLoad 缺省 false，v9→v10 只补缺省字段。本轮完整配置测试通过。

独立真实 Scheduler 设 multiLoad=false、maxLoaded=1，依次以 confirmed=false 启动 A、B；admit 调用次数为 0，A stopped、B ready。新增 unconfirmed 条件只在 multi 分支生效，未发现默认单开被新确认门槛拒绝。停止/排空/旧请求租约的产品接线未修改。Mac DTO 字段变化是检查接口的有意修改，不等于整个 API 字节级保持旧版；未做全部旧功能的跨版本端到端比较。

## 实际验证记录

| 命令 / 执行方式 | 结果 |
| --- | --- |
| `bun test` | **1302 pass / 56 skip / 0 fail，退出码 0**；1358 项、97 文件、5904 个断言，66.18 秒。没有失败项。新增两个测试文件参与执行；Windows 跳过的 POSIX 等用例未算通过。 |
| `bun run typecheck` | **通过，退出码 0**，Nuxt/vue-tsc 无类型错误。 |
| `bun --eval`：真实 GGUF reader/model-facts/估算器、三片布局和损坏后片 | 正常退出；合并、fallback、Windows/Mac 视觉计数及 ngl/output 边界结果见上文。临时 GGUF 仅含合成头，finally 清理。 |
| `bun --eval`：真实 buildLaunchArgs/finalParams/estimateMemory | 最终正常退出；视觉表单/extra 优先级通过，复现 CR-019 的错误逐卡预算。首次脚本错误引用了不存在的导出名，导入失败、未形成验证；更正为实际导出后重跑。没有修改产品文件。 |
| `bun --eval`：真实 Scheduler/ModelOps、挂起 admission 和假进程 | 正常退出；复现 CR-013 内部切方案与 CR-018 两种等待者变化。所有 Scheduler 在结束时 shutdown，无真实服务子进程。 |
| `bun --eval`：原 useModelStartFeedback + Vue | 正常退出；复现 CR-021 pending 未清理、notice=null。 |
| `bun --eval`：隔离真实 context/service/stats | 正常退出；复现 CR-020 运行时/文件变化后复用记录，并验证 Mac 返回字段。finally shutdown、恢复环境和 context 全局引用、删除夹具；清理时 context 的后台更新检查被 shutdown 取消，不涉及运行模型。 |
| `bun --eval`：原 useMemoryChecks + Vue、DeviceProbe、darwin noRoomText 函数体 | 正常退出；dirty 多次合并和失败收尾通过，证实探针缓存行为及 CR-016 残留文案。 |
| `bun --eval`：真实 Scheduler/routing、单开与重载/同名/同毫秒 | 正常退出；单开不调用 admission，同毫秒及重载后选择正确。另证实三个 split mode 的估算输入缺失/结果相同。 |

独立脚本没有落为仓库测试，本文给出可复现输入、调用顺序和实际输出。合成进程/layout 的复现只证明相应软件逻辑，不能替代真实加载。测试与类型检查均针对本轮未提交修复工作区；作者交接的其他平台计数未作为证据沿用。

## 待确认（不混入已确认发现）

- 修复 CR-018 后，手动确认、请求来源、内部重启的共享加载授权应有统一契约；本轮未遍历所有取消/腾空间组合，尚不能保证全部混合等待者时序正确。
- 实测下限没有包含 compute/fixed，外部程序释放资源可使差值偏小；是否需要多次采样、可信度或拒绝向下修正，要结合真实 WDDM 数据，不凭本轮合成输入决定具体系数。
- 新分片合并是否会因超大 tensor header 增加 UI 队列延迟，未做性能基准；没有性能失败证据。
- 视觉 offload 的其他设备指定参数、运行时环境变量、自动 fit、架构特有峰值不在本次开关复现内；未报告它们已被完整建模。

## Windows / CUDA / 多卡仍依赖的未验证假设

- CUDA 设备 ID、nvidia-smi 索引、可见设备及顺序映射正确，分组不会对应错卡。
- device free/total 与可用于本次分配的量一致，探针到真正启动之间的外部变化可控；一分钟展示缓存不是实时值。
- WDDM 的整卡 used 前后差值可归因于本次加载，驱动缓存/外部应用不会明显污染测量；本服务的串行不能保证这一点。
- 固定 512 MiB 开销、compute 公式、视觉缓冲经验量及 FA/cache 假设覆盖实际构建和架构峰值；没有 Windows 系数校准。
- layer 的比例与数值语义必须与实际构建匹配；CR-019 已证实边界不匹配。row/tensor 的逐卡权重、缓存及计算缓冲需要独立模型和实测。
- 自动 fit、部分 offload、CPU 视觉路径及加载失败时的内存回收与预估口径一致；看门狗 5% 阈值/周期可在真实压力下及时行动。

## 本次没审 / 没法审

- **未运行真实 llama-server、CUDA 模型、多模型推理、真实 OOM/驱动异常/显存压力或 GPU 冒烟；没有占用 GPU。** 本轮 Scheduler 进程为假对象，GGUF 为合成头。
- **未运行双卡/三卡/多 GPU 真机、WDDM 数值校准、row/tensor 逐卡实际占用、不同 CUDA 构建矩阵、真实视觉/分片/循环/MoE 模型峰值。** 上游参考固定 b11146，没有执行该 C++ 程序。
- **未运行 Mac/Metal 真机或浏览器。** Mac 返回字段和文案通过分支/函数体注入验证，不声称真实 Mac HTTP 或看门狗已跑过。
- **未运行首次设置→确认框、保存后重启、切方案的浏览器端到端，未建立真实公网隧道。** 这些路径检查代码接线并执行对应核心/service/composable，不等同于整条 HTTP/SSE/UI 验收。
- **未运行 build、桌面打包/安装/退出、发布和跨版本全功能对照。** 未切换、提交或清理作者已有工作区改动。
- 没有重做上一轮全部进程树/残留清理/OOM 退出复现；相关代码未在本轮差异中改变，完整测试覆盖有限，56 个跳过用例仍属未执行。
- 本轮不扩大为全仓安全审计、全部 llama.cpp 参数/环境变量、性能压测或操作系统故障注入。没有据未运行的硬件现象新增 critical。
