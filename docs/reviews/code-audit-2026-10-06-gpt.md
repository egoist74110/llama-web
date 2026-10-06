# 阶段 9 独立交叉审查 · 2026-10-06 · GPT

## 总体结论

**结论：rework required，当前不能通过阶段 9 关口。** 本轮新增 4 项 major、4 项 minor，没有确认的 critical。阻塞项是 CR-010～CR-013：分片模型的层权重、关闭视觉投影加速、双卡层分配均可能把实际放不下的资源判断为 `ok`；手动启动的风险确认没有进入最终加载队列。此外，CR-015 对应的现有测试失败，尚未满足仓库要求的完整测试关口。

审查基线为 `c69b138`，检查阶段 9 提交区间 `994df9a`～`c69b138`，并沿调用链检查 Runner、残留清理、路由、配置迁移和前端接线。开始时工作区干净。已阅读 AGENTS.md、路由规则、计划的多模型行为规则/决定 9、41、42/阶段 9 清单、会话指南、最近五条阶段 9 交接，以及前两份审查报告。作者结论仅用于定位，以下结论来自本轮代码阅读、执行结果和独立构造输入。

本轮只新增本文；没有修改实现或测试，没有提交或推送。没有读取真实的 `data/secrets.json`。需要 context 的复现使用隔离临时目录和合成配置，结束后关闭 context/子进程并清理夹具。下文内存值均为 MiB，模型和设备输入均为构造数据。

## 新问题（按严重程度排序）

### CR-010 · major · 分片模型把第一片的层分布放大，后续片中的层仍按零权重计算

- **位置：** `server/core/model-facts.ts:40`；`server/core/memory-estimate.ts:215`～`217`。
- **问题：** 只读第一片的 tensor layout，再乘全部文件大小与第一片 tensor 大小的比值，不能恢复其他片的逐层权重；部分 offload 时会严重低估设备占用，却标为非猜测结果。
- **失败场景：** 四层模型，第一片 tensor 共 100 MiB：embedding 20、层权重 `[40, 40, 0, 0]`，输出与 embedding 绑定；全部分片合计 1000 MiB，后两层实际各 450 MiB。设置 `gpuLayers=3`、ctx 1024、parallel 1，设备空闲 1000 MiB，系统内存充足。后两层及输出复制应占设备权重 920 MiB，代码只算 200 MiB；含缓存和固定开销，给出 `ok / 732.5 MiB`，按完整层权重应为 `1452.5 MiB > 1000 MiB`。
- **证据：** `loadModelFacts()` 对所有片仅 `stat()`，`readGguf()` 仅调用一次。`weightsOf()` 将第一片缺失层的零值乘系数，仍得到零；总文件大小正确不代表每个内存池正确。
- **最小复现：** 构造上述 `ModelFacts`（`sharded=true`、`layout.tensorBytes=100 MiB`、`totalBytes=1000 MiB`），调用真实 `estimateMemory()`；再用完整层布局比较设备权重。独立 `bun --eval` 得到：

  ```json
  {"tier":"ok","estimatedDeviceWeights":200,"estimatedDeviceTotal":732.5,"actualRemainingShardDeviceWeights":920,"correctedDeviceTotal":1452.5}
  ```

- **建议修法：** 读取并合并全部分片的 tensor layout，按 tensor/层归属汇总。无法取得完整分布时标为 `unknown` 或采用明确保守的分配，不能沿用第一片的零值。补充不同层分别落在不同分片、部分 offload 的用例。
- **复现状态：** **已复现估算错误**，执行的是原估算器与合成布局；真实分片 GGUF 加载、CUDA OOM **未运行**。

### CR-011 · major · `--no-mmproj-offload` 没有进入估算，CPU 视觉投影仍算在设备上

- **位置：** `server/core/model-check.ts:60`～`102`；`server/core/memory-estimate.ts:382`；相关参数生成 `server/core/args.ts:411`。
- **问题：** 参数生成支持关闭视觉投影 offload，但最终参数解析和估算输入没有对应字段，只要主模型选择设备，就把 mmproj 全算到第一个设备池。
- **失败场景：** 主模型在 CUDA0，视觉文件 2048 MiB，设置 `--no-mmproj-offload`。系统总量 16000、可用 2600，扣除保留量后预算 200；设备空闲 14000。CPU 视觉权重本身就超过系统预算，代码却给出 `ok`：设备 mmproj 2867.2、系统 mmproj 0，系统总需求约 17.384。反过来，系统充足而设备不足时，也会误拒原本可放在 CPU 的视觉文件。
- **证据/最小复现：** 对同一 `checkLaunch()` 输入分别追加/移除 `--no-mmproj-offload`；ctx 1024、parallel 1、ngl 999、FA on、四层小模型、上述预算。独立 `bun --eval` 执行真实检查函数，两次内存池结果完全相同；关闭 offload 后仍输出 `tier=ok`、`system.mmprojMiB=0`。
- **建议修法：** 从最终 argv 解析视觉 offload 开关，传入估算器，并按最终参数把视觉权重及相应缓冲放入 host/device 池。补充两种模式的预算边界测试，不能只检查 argv 是否包含开关。
- **复现状态：** **已复现检查结果错误**；真实视觉模型在 CPU 加载及 OOM **未运行**。

### CR-012 · major · 双卡层分配与 llama.cpp 的实际阈值不同，单卡预算可能被低估

- **位置：** `server/core/memory-estimate.ts:237`～`240`、`277`。
- **问题：** 估算按重复层数乘比例向下取整、从末卡分配余数，并另行把输出放末卡；实际 layer split 使用包含输出层的 offload 层数计算累计比例阈值。
- **失败场景：** 四个重复层，每层权重 512 MiB，embedding/output 各 1 MiB且不绑定，全部 offload，双卡比例 `0.5,0.5`，空闲量分别 1900、6000，系统充足。代码分配重复层为 `[0,0,1,1]`；上游阈值分配为 `[0,0,0,1]`。第一张卡估算总需求 1556.5，判断 `ok`；计入实际多出的一层及其 KV 后约 2069，超过 1900。
- **证据：** 独立执行真实 `assignLayers()`/`estimateMemory()`，并查阅上游 `ggml-org/llama.cpp` 的 `b11146` 标签、`src/llama-model.cpp:1437`～`1461` 作比较。上游使用 `act_gpu_layers=min(n_gpu_layers,n_layer_all+1)`，按 `(il-i_gpu_start)/act_gpu_layers` 对累计 `tensor_split` 做 `upper_bound`，输出层也进入该分配过程。这是代码公式差异，不以真实双卡压力测试作为前提。
- **最小复现：** 调用 `assignLayers(4, 999, [0.5,0.5])` 得到 `[0,0,1,1]`；对上游公式计算 `il=0..3`、`i_gpu_start=0`、`act_gpu_layers=5`，得到 `[0,0,0,1]`。再用上述逐层权重与设备预算执行估算即可得到错误的 `ok`。
- **建议修法：** 按所用运行时的实际累计阈值分配重复层和输出层，再汇总逐池权重/KV。补充输出层参与比例、不同 GPU 层数、非均匀层大小及比例边界测试。不同 split mode 应各自采用匹配的资源模型。
- **复现状态：** **已复现公式及预算错误**；双 GPU 真机加载 **未运行**。此项确认的是 layer split，row/tensor 的实际资源归属另列待确认。

### CR-013 · major · 手动启动只在入队前确认风险，最终 admission 不知道是否得到确认

- **位置：** `server/api/models/[id]/start.post.ts:12`～`13`；`retry.post.ts:11`；`server/core/scheduler.ts:557`～`560`。另一路径：`server/api/models/[id]/setup.post.ts:35`。
- **问题：** `checkedStart(target, confirm)` 与后台 `ops.start(target)` 分离，队列任务没有保存确认状态；实际加载时无条件接受手动启动的 `risky/unknown`。首次设置的 `start:true` 还直接调用 `ops.start()`，完全没有这次风险预检。
- **失败场景：** 手动启动预检时为 `ok`、`confirm=false`；排队期间另一模型占用内存或外部程序减少空闲量；最终 admission 已为 `risky` 或 `unknown`。调度器只拦 `nofit`，以及请求触发且有其他在线模型的 `unknown`，于是无需用户风险确认就起进程。
- **独立复现：** 使用真实 `getContext()`、`precheckStart()`、`ops.start()` 和调度器，注入内存探针与假 `ModelProcess`。多开开启，maxLoaded 4，初始设备空闲 22000、系统可用 60000；`precheckStart(target,false)` 通过后，把设备空闲改为实际估算的 1.05 倍，再调用 `ops.start(target)`。实际输出：

  ```json
  {"precheck":"ok","confirm":false,"queuedCheck":"risky","state":"ready"}
  ```

- **最小 HTTP 场景：** 第一个模型仍在加载/采样时提交第二个模型的未确认 start，待第二个模型真正出队前降低空闲量；检查它是否得到新的确认要求。该 HTTP 场景 **未运行**，上述真实 service/调度器接线已复现同一丢失确认的路径。
- **建议修法：** 把手动来源及风险确认显式带入排队任务，最终 admission 对未确认的 `risky/unknown` 拒绝并返回可被界面识别的原因；start/retry、首次设置后启动、保存后重启统一使用此契约。若预检后条件变化，需要新的风险回答，不能靠“界面此前应该问过”推断授权。
- **复现状态：** **已复现**。此处不是 `confirm:true` 强行绕过 `nofit/limit`：两者仍被拦截；也没有发现公网请求绕过调度器 admission 的直接加载路径。

### CR-014 · minor · 在线集合变化时的强制重算被在途请求吞掉，旧结论被重新标为新鲜

- **位置：** `app/composables/useMemoryChecks.ts:21`、`25`～`31`、`48`～`49`。
- **问题：** 同 key 在途时 `force=true` 也直接返回，没有失效版本或待重算标记；旧响应照常写入，并用响应完成时间刷新 15 秒缓存时间。
- **失败场景：** 模型 A 的检查正在返回，在线集合从 A 变成 A+B，watch 发起强制检查但被 `inflight` 丢弃；A 的旧 `ok` 覆盖到当前页面，没有第二次检查。15 秒仅是再次调用 `request()` 时的复用条件，没有定时过期重算，页面可一直保留旧结论。
- **证据/最小复现：** 执行原 composable 函数体，经 Bun TypeScript 转译，仅提供 Nuxt 自动导入依赖和可控 `$fetch`；使用真实 Vue 响应式/watch。`followModel(A,p)` 后挂起首个响应，修改 `useLive` 在线集合为 A+B，等待 `nextTick()`，释放旧 `ok`。独立结果：

  ```json
  {"onlineModels":2,"fetchCount":1,"publishedTier":"ok","recheckAfterChange":false}
  ```

- **建议修法：** 请求携带在线集合/配置的版本标记；旧版本响应不能成为当前有效结论。集合变化时若已在途，记录 dirty 并在结束后串行重算；只给最新有效版本写入缓存时间。补充慢响应和在线集合连续变化的测试。
- **复现状态：** **已复现原响应式接线**；浏览器页面操作 **未运行**。最终加载的 admission 仍会重算，所以此项主要损害提示的可信度，不是硬拦截的直接绕过。

### CR-015 · minor · 已知 mlock 失败来自测试未隔离 Windows 默认参数

- **位置：** `tests/service/multi-load.test.ts:171`；默认参数来源 `server/core/args.ts:101`、`server/core/config.ts:231`。
- **问题：** 测试把“默认方案”当成不带 mlock，但 Windows CUDA 的默认全局参数本来包含 `--load-mode mlock`，空方案会继承它。
- **失败场景：** 多开开启、系统空闲量极低；显式“锁定”方案与默认方案都实际带 mlock。产品对两者都返回 `mlockDropped=true`，测试却要求默认方案为 false。
- **证据/最小复现：** 原样运行 `bun test tests/service/multi-load.test.ts`：9 pass、1 fail。失败断言为第 171 行，Expected false / Received true。完整套件也仅此项失败。默认参数的最终解析与产品的去除 mlock 行为符合当前计划；没有证据支持改产品为“默认方案不检查 mlock”。
- **建议修法：** 在对照夹具中显式设置不带 mlock 的全局 extraArgs，或明确检查 Windows 默认方案继承 mlock，再增加真正无 mlock 的对照。保留多开开/关两种行为测试。
- **复现状态：** **已复现，判断为测试问题**。当前失败由 Windows 默认 CUDA 参数触发；mlock 的检查/去除算法本身不是 Windows 专有缺陷。Mac 默认参数没有该参数，解释了平台间结果可能不同；本轮 Mac 执行 **未运行**。也未在本轮执行 stash/切换旧提交，只评价当前基线。

### CR-016 · minor · Mac 检查接口仍返回 GPU 字段，部分共用文案仍显示 GPU/显存

- **位置：** `server/core/model-check.ts:89`；`server/api/models/[id]/check.post.ts:22`；`app/components/ProfileForm.vue:293`、`348`；`app/components/SettingsDefaults.vue:144`；`i18n/zh-CN.ts:688`、`690`、`865`。
- **问题：** Mac 分支虽然替换了主要参数标签，完整检查结果仍含 `params.gpuLayers`，参数分组说明还无条件引用 Windows 口径的 GPU/显存文本。
- **失败场景：** `os='darwin'` 的 `checkLaunch()` 返回 `params.gpuLayers`；检查路由原样展开该对象。Mac 编辑页仍引用“视觉文件放显存还是内存”“GPU 层数”等分组说明。手动 unknown 拒绝文案（`i18n/zh-CN.ts:485`、`server/service/admission.ts:92`）也未按平台切换。
- **证据/最小复现：** 对真实 `checkLaunch()` 传 darwin 输入，执行 `Object.keys(result.params).filter(k => /gpu/i.test(k))`，得到 `["gpuLayers"]`；结合原样返回的路由代码确认接口字段。上述 Vue 模板与文案引用没有 Mac 条件。主要字段的 `paramText` Mac 替换已存在，问题是遗漏了外围说明和返回 DTO。
- **建议修法：** 内部 argv 参数可保留，实现面向平台的返回 DTO 和文案选择；Mac 输出使用中性加速字段/口径。补查分组说明、启动拒绝和代理错误，不只检查表单字段 label。
- **复现状态：** **已复现纯函数返回字段，文案遗漏经代码确认**；真实 Mac HTTP 与浏览器 **未运行**。

### CR-017 · minor · 最近使用时间同毫秒时，无 model 请求会选错 ready 模型

- **位置：** `server/core/scheduler.ts:475`；`server/core/routing.ts:31`。
- **问题：** 路由只按 `Date.now()` 时间戳选模型，同毫秒平局时选择遍历靠后的实例，忽略调度器已有的单调 `useSeq`。
- **失败场景：** A ready、B ready，同一毫秒依次请求 A、B、A；最近使用应为 A。两者 `lastUsedAt` 相同，实例列表中 B 靠后，于是不带 model 的下一请求被送到 B。
- **证据/最小复现：** 真实 Scheduler 配合假进程，固定 `Date.now()`；依次 `acquire(A)/release`、`acquire(B)/release`、`acquire(A)/release`，再把 snapshot 交给真实 `resolveTarget()`。独立输出：

  ```json
  {"latestRequested":"a","selected":"b","timestamps":[123456,123456]}
  ```

- **建议修法：** 使用/暴露调度器已有的单调使用序号作路由排序，时间戳只用于展示；至少为同毫秒交替请求补测试。
- **复现状态：** **已复现**；正常不同时间戳的 ready 选择和 loading 回退用例通过。

## 十项重点问题的明确结论

“没问题”仅表示在下述检查与执行范围内未发现问题，不替代未运行的硬件验证。

| 用户问题 | 结论 | 本轮证据与边界 |
| --- | --- | --- |
| 1. 多进程生命周期、注册、停树、残留 | **没问题（已验证范围内）** | `PidRegistry` 使用多条记录和原子写；`Runner.stopAll()` 遍历全部子进程，context 退出调用 scheduler shutdown 和 runner stopAll。Windows 独立运行两个带子进程的 Bun 假服务：注册 2 条，停止 A 后只剩 B，B 健康返回 200；stopAll 后记录为 0、四个父/子 PID 都退出、两个端口可重新绑定。`residue.ts:74` 同时校验注册 birth、实际/再次查询的 birth、物理可执行路径及 runtime 边界；对应目录越界/PID 复用/用户独立进程用例通过。真实 llama-server 残留端到端未运行。 |
| 2. 加载串行、卸载/请求/看门狗竞态 | **有问题：CR-013** | 全局队列 `pump()` 等待整个 `runLoad()`；context 的 gated ready 包含加载后采样，真实 Windows Runner 挂起采样复现中第二个模型未提前启动。看门狗采样后取候选，`idleOnly` 在卸载入口同步检查租约，相关回归通过。请求腾空间/手动停止可以进入 draining 等在途请求结束，超时才中断，这是计划行为；看门狗不能卸载已有在途请求的 ready 模型。确认状态在预检和出队之间丢失，见 CR-013。 |
| 3. admission 绕过、公网/upstream/manual、503/409 | **有问题：CR-013；未发现 nofit/limit 的直接硬绕过** | 公网 `/v1/*` 与本地共用 proxy→scheduler.acquire→admission；`/upstream/*` 只接受已有 ready 实例，取得租约前没有异步加载分支。start/retry 先检查，真正加载再 admission，但手动 risky/unknown 的确认丢失；setup 的 start 直接入队。`confirm:true` 仍不能覆盖 nofit/limit。普通 API 拒绝为 503 `insufficient_memory`；手动预检为 409，unknown 策略因来源而不同，符合计划。已发头的流式拒绝使用 HTTP 200 + SSE error，不能再改 HTTP 为 503，消费者处理有回归覆盖。硬件映射错误 CR-010～012 则使 admission 得到错误输入结论。 |
| 4. 估算偏低、真实 OOM/退出后的状态一致性 | **没问题（软件失败路径）** | `scheduler.ts:582`～`598` 失败时停止 proc、清空引用、进入 failed 并拒绝等待者；Runner 退出释放注册与端口。真实 Windows 假服务在 ready 后采样期间被终止，结果为 failed、PID 死亡、Runner 数量 0，没有死亡实例 ready。OOM 日志识别/退出等单元用例通过。请求为腾空间卸载的旧模型没有自动恢复，计划没有规定事务式恢复；不会把旧模型伪装成仍在线。真实 CUDA OOM、驱动异常及极限压力未运行。 |
| 5. 缺 model 选择、默认关多开、v10 迁移 | **有问题：CR-017；默认和迁移未发现问题** | 一般情况按最近 ready，随后才 loading；同毫秒最近使用违反规则。默认 `multiLoad=false`，`effectiveMaxLoaded()` 返回 1，内存 admission/看门狗不开启；v9→v10 只对缺失的 multiLoad/onNoRoom 使用 `??=`，保留其他设置，配置/调度器回归通过。未声称真机上的所有旧行为已逐一对比。 |
| 6. 保存检查是否误拒/放行 | **没问题（规定的三类校验）** | `model-check.ts` 仅 V 量化缓存且 FA 显式关闭、所选设备不存在、所选 split mode 不支持生成 error；profiles 保存经 `checkBeforeSave()` 拒绝 blocked。ctx/batch/CPU 层等问题仅 warning，内存档位不阻止保存，对应测试通过。不把潜在 OOM 等同于必须禁止保存；它应由加载拦截处理，CR-010～013 是该层缺陷。三类规则的真实不同运行时启动行为本轮未重测。 |
| 7. 实测记录原子写/版本/并发/隐私 | **没问题（当前格式与接线）** | `vram-stats.ts` 使用 version、16 位哈希键、数字数组/时间，临时文件再 rename，不写模型名/路径；校验、坏文件、新版本处理和原子保存用例通过。context 比较采样窗口内 memoryEvents，状态变化不记录；全局串行覆盖采样，减少互相污染。这里只检查合成存储文件；测量噪声与记录失效条件另列待确认。 |
| 8. Mac 口径与 Windows 未验证假设 | **有问题：CR-016** | darwin 返回 GPU 字段及共享说明/拒绝文案有遗漏。Windows 软件进程树已实际验证；CUDA 数值口径、WDDM 差值、多卡归属仍未真机验证，具体假设见下文。 |
| 9. 前端串行/15 秒/在线重算、unknown 保存确认 | **有问题：CR-014；unknown 保存处理合理** | chain 的串行执行成立，但 inflight 吞掉 force，旧结论仍可持续显示。`saveRisk` 对 unknown 不开确认弹窗符合阶段 9 的明确决定；无法判断不等于禁止保存，检查错误/缺结果也不能充当可加载证明。实际启动仍须遵守独立启动确认和 admission。 |
| 10. 已知 mlock 测试失败归属 | **有问题：CR-015，为测试夹具问题** | 完整套件及单文件均独立失败。Windows 默认 CUDA extraArgs 带 mlock，默认方案会继承，产品对它执行 drop 检查是正确行为；不应为通过错误断言修改产品逻辑。非 Windows 实机本轮未执行。 |

## CR-001～CR-009 修复复核

没有重复创建旧问题编号；以下状态对应原触发条件，不能推广为该模块没有其他问题。

| 旧编号 | 本轮结论 | 独立依据 |
| --- | --- | --- |
| CR-001 | 修复到位 | Watchdog 在 await 后取候选，Scheduler `idleOnly` 同步挡已有租约；挂起采样后请求开始的回归通过。 |
| CR-002 | 修复到位 | `worstTier` 保留 `ok < risky < unknown < nofit`，混合 risky/unknown 与未知预算旁边已有模型的回归通过。 |
| CR-003 | 修复到位 | 历史实测不把未知当前预算改为已知，preferMeasured 的 unknown 回归通过。 |
| CR-004 | 修复到位 | SSE 消费者遇 error 会抛出原因并保留已有正文，对应解析/代理错误回归通过。 |
| CR-005 | 修复到位 | 看门狗遍历告急池；测试已使用只关联 system 的空闲候选并检查池，相关回归通过。 |
| CR-006 | 修复到位（代码及测试） | 两种存储后端均包 tombstone，删除后拒绝写回，对应 chat/store 用例通过。真实浏览器 IndexedDB/生成收尾本轮未运行。 |
| CR-007 | 修复到位 | 调度器等待 gated ready；本轮真实 Windows Runner 的独立挂起采样复现：释放前启动次数 1，释放后才为 2，A/B 最终 ready。 |
| CR-008 | 修复到位 | 采样等待 race 包含退出，catch 后仍检查 exitedInfo。本轮在采样期间杀死自有假服务，得到 failed、无活 PID/Runner，不再成为 ready。 |
| CR-009 | 原读取污染已消除；平台整文件未运行 | 断言改为读取最新两条记录，不再将前序条目误作本次两次采样。原 POSIX service 用例在当前 Windows 平台跳过；本轮另用 Windows 真实 Runner 验证串行和退出接线，未声称原整文件执行通过。 |

## 实际执行的验证

| 命令/执行方式 | 结果 |
| --- | --- |
| `bun test` | **1290 pass / 56 skip / 1 fail**；1347 项，95 文件，5867 个断言，56.77 秒。唯一失败是 CR-015 对应的 `mlock that would lock more than the free memory is dropped (only with the switch on)`。 |
| `bun run typecheck` | **通过，退出码 0**；Nuxt/vue-tsc 无类型错误。 |
| `bun test tests/service/multi-load.test.ts` | **9 pass / 1 fail，退出码 1**；28 个断言。第 171 行 Expected false / Received true。 |
| 下列十个文件的集中 `bun test` | **158 pass / 0 fail**，672 个断言；覆盖调度器、多池看门狗、估算、实测记录、保存校验、admission、代理拒绝、路由与前端工具。 |
| `bun --eval`：原估算/检查函数的分片、视觉 offload、双卡分配构造输入 | 正常退出；CR-010～012 的错误结果如上。 |
| `bun --eval`：真实 context、service 和 Scheduler，注入内存与假 ModelProcess | 正常退出；CR-013 从未确认 ok 到实际 risky 仍进入 ready。 |
| `bun --eval`：原 useMemoryChecks + 真实 Vue + 挂起 fetch | 正常退出；CR-014 在线集合变化后只有一次请求，旧响应被发布。 |
| `bun --eval`：darwin 检查参数；真实 Scheduler/routing 同毫秒输入 | 正常退出；分别复现 CR-016 的 GPU 字段与 CR-017 的错误选择。 |
| `bun --eval`：Windows 真实 Runner，两个带子进程的假 HTTP 服务 | 正常退出；只停止 A 不影响 B，stopAll 杀完全部父/子进程并释放端口。 |
| `bun --eval`：Windows 真实 context/Runner，加载后采样挂起及退出 | 最终正常退出；验证 CR-007/008 已修复。首次夹具使用默认端口遇到 `EADDRINUSE`，该次未形成有效验证；清理后改用独立端口范围重跑通过。这是夹具端口冲突，不列产品缺陷。 |

集中测试命令为：

```text
bun test tests/core/scheduler-multi.test.ts tests/core/watchdog.test.ts tests/core/memory-estimate.test.ts tests/core/vram-stats.test.ts tests/core/model-check.test.ts tests/core/admission.test.ts tests/core/proxy-no-room.test.ts tests/core/routing.test.ts tests/app/memory-check.test.ts tests/app/chat.test.ts
```

独立执行没有给仓库添加复现测试。上文保留了构造输入、调用次序及关键实际输出，可据此补入回归用例；使用假进程/合成 layout 的结果证明相应逻辑错误，不证明真机 OOM 已发生。全文的“通过”不包含跳过用例。

## 待确认（不作为已确认问题）

1. **实测记录的失效条件。** `server/service/model-check.ts:87` 的 key 摘要没有明确包含运行时版本和完整文件身份变化。相同模型/profile/参数更换运行时或文件后，是否错误复用旧占用，需补版本/文件替换复现；本轮未运行。记录没有明文隐私字段不等于占用长期有效。
2. **采样的外部干扰。** memoryEvents 只反映本服务的模型状态，不能识别外部程序在窗口内申请/释放资源；系统 used 差值还可能混入页缓存/其他进程。这是估计误差来源，当前没有真实负载下的失败证据。
3. **row/tensor 模式的逐池估算。** CR-012 确认 layer 模式与已核对上游版本的公式差异；其他模式的 tensor/KV/计算缓冲归属是否符合实际构建，仍需分别检查和多卡实测。
4. **前端“重新检查”的探针新鲜度。** `ProfileForm.refreshCheck()` 和共享队列请求没有传 `fresh:true`，检查路由允许复用一分钟内的设备列表。它与 15 秒 UI 复用的叠加，是否可产生额外过期提示，尚未构造计时复现。最终 admission 的新鲜探针不能自动使展示结果变新。

## Windows / CUDA 代码依赖的未验证假设

- llama.cpp 设备枚举的 CUDA ID 与 `nvidia-smi` 卡索引能正确对应；设备可见性、顺序变化和多卡环境不会错配池。
- `--list-devices`/`nvidia-smi` 的 free/total 数值反映可用于这次 llama 加载的预算；探针读取与真正分配之间的外部变化足够小。
- WDDM 下单进程占用不可用时，整卡 used 的前后差值能近似归因于本次加载；采样时没有其他应用/驱动缓存干扰。软件串行只能排除本服务同时加载，不能证明该数值假设。
- 固定运行开销、compute buffer 公式、视觉文件的经验系数和 FA/cache 假设足以覆盖不同架构、上下文、批量及图像输入的峰值。合成用例通过不等于系数已在硬件校准。
- 运行时自动拟合/实际 offload 与启动前估算使用的层数及资源位置一致；如运行时搬移到系统内存，估算与实测需要相应解释。
- 看门狗的 5% 阈值和采样周期能在实际 CUDA/WDDM 压力下及时行动；当前已验证的是决策、租约及停进程代码，没有验证真实驱动/操作系统的反应时间。

## 本次没审 / 没法审

- **未运行真实 llama-server/CUDA 模型加载、多模型推理、真实显存不足/OOM、驱动重置、极限压力或 GPU 占用冒烟；没有占用 GPU。** Windows 的独立实进程验证使用 Bun 假服务，不能替代 GPU 关口。
- **未运行双卡/多 GPU 真机、WDDM 显存采样校准、不同 CUDA 构建矩阵、真实视觉/分片/循环/MoE 模型的占用校准。** CR-010～012 是代码/公式复现；硬件后果尚需实测。
- **未运行 Mac/Metal 真机、vm_stat 系统口径校准或真实 Mac 页面。** 本轮只执行 darwin 纯逻辑分支并检查接口/模板接线。
- **未运行浏览器端到端、实际 IndexedDB、首次设置/保存重启/风险弹窗的完整交互，也未启动真实公网隧道。** 公网/upstream admission、鉴权和来源识别只检查接线及已有回归测试。
- **未执行 `bun run build`、桌面打包/安装/退出冒烟、发布流程；没有切换旧提交做跨版本真机对照。** 设置迁移检查基于当前代码和测试。
- 磁盘空间与下载前检查阅读了相关接线及完整套件结果；未做真实低磁盘下载、磁盘故障、rename 失败/断电、配置恢复等操作系统故障注入。
- 本轮不扩大为整个仓库的安全审计、性能审计或所有底层 llama.cpp 参数验证。56 个跳过用例没有被算作通过；原 POSIX 集成用例的未执行限制已在修复复核中注明。
