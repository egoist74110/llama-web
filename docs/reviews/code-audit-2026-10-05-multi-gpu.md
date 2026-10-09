# 8-7 多 GPU：设备组与切分审核 · 2026-10-05

## 结论与边界

**结论：rework required。** 本轮发现 4 项 major、3 项 minor，均为 open。现有测试通过，但最终参数、启动期失败记忆和逐卡预算之间存在可复现的不一致，不能据此认定 8-7 已完整验收。

- 基线：`553b654317129e34e7b3429c5c9f3a7a3421a2dc`。
- 已读取 router、AGENTS、计划、会话指南、最新交接、`docs/research/multi-gpu.md` 和 `docs/reviews/code-audit-2026-10-05-r3.md`；按 `code-review` 技能审核。
- 本轮是独立的 8-7 审核，检查当前实现及其阶段 9 接线，不重新打开上一批 CR-001 至 CR-009。
- 范围：三层设备配置与额外参数覆盖；运行库设备与模式探测；首次确认、失败记录及诊断；最终参数到逐卡估算、加载统计、在线看板归属的调用链。
- 不覆盖用量、MTP 本身、回收站、推荐参数、桌面更新发包等下一批模块；草稿模型只检查与 GPU 预算有关的接线。
- 开始时已有基线改动：`code-audit-2026-10-05.md`、`code-audit-2026-10-05-r2.md` 修改，以及未跟踪的 r3 报告。本轮保留它们，只新增此报告；没有修改实现、仓库测试、计划或交接，没有提交或推送。

## 问题列表

| ID | 严重程度 | 状态 | 问题 |
| --- | --- | --- | --- |
| MGPU-001 | major | open | 加载失败通过 `ready` 返回，绕过切分失败记忆和专属诊断 |
| MGPU-002 | major | open | 额外参数设备组被降为 `auto`，逐卡预算丢卡，还可能被补上 `split-mode none` |
| MGPU-003 | major | open | 额外参数覆盖模式后，能力检查和组合键仍使用表单模式 |
| MGPU-004 | major | open | 逐卡估算没有模式和主 GPU 输入，把 row / tensor 当作 layer 分层 |
| MGPU-005 | minor | open | 修改设备组或运行库后，新的实验组合没有首次确认 |
| MGPU-006 | minor | open | 自定义运行库以显示名称作为组合身份，不同构建共享确认和失败状态 |
| MGPU-007 | minor | open | 在线模型的卡片归属来自当前保存配置，保存不重启会误标旧进程 |

### MGPU-001 · major · 加载失败不会写入切分失败记忆

**位置：** `server/service/context.ts:471`、`:478`、`:486–491`；契约来源为计划决定 45 / 8-7 第二项。

`Runner.start()` 分配端口并返回进程对象，加载结果通过 `rp.ready` 返回（`server/core/runner.ts:246–260`）。context 的失败记录只放在 `await runner.start()` 外层 catch 中；`rp.ready` 被包装为 `gated` 后直接交给 scheduler。其 rejection 分支只是停止进度跟踪并重抛，不经过 `splitStats.fail()` 或 `SplitModeLoadError`。

**独立夹具结果：** 合成 Windows / CUDA 平台、两张假 GPU，真实 context + Scheduler + Runner 启动一个实际 Bun 子进程。子进程在健康就绪前输出 `device CUDA0 does not support split buffers` 并以 1 退出。组合事先已确认。

```json
{
  "state": "failed",
  "schedulerError": "failed",
  "diagnosis": {
    "kind": "exited",
    "code": "exited",
    "exitCode": 1,
    "tail": ["device CUDA0 does not support split buffers"]
  },
  "record": { "confirmedAt": "存在，failed 字段不存在" },
  "childCount": 0
}
```

**影响：** 常规的加载提前退出 / CUDA 失败不能触发已宣称的失败记忆，之后启动已确认组合也不会获得 `split-mode-failed-before`；用户只看到普通退出诊断。现有 `multi-gpu.test.ts` 直接测试 `SplitStats.fail()` 和错误包装，不证明真实加载失败会调用它。

**建议：** 对交给 scheduler 的最终 ready Promise 统一处理符合条件的失败，保留 OOM、超时、参数、文件、取消等排除规则；仅在最终加载成功后清除失败标记。补真实 Runner 假子进程的失败→读取持久化记录→下一次预览警告测试，及 OOM / 取消不记忆的对照。

### MGPU-002 · major · 手写设备组丢失最终设备集合

**位置：** `server/core/args.ts:314–315`；后续 `server/core/launch.ts:218–220`、`:286–305`，`server/core/model-check.ts:161–164`。

`extraDevice()` 将 `--device CUDA0,CUDA1` 送入只支持单值的 `normalizeDevice()`，失败后返回 `auto`。参数数组保留设备组，但 `LaunchPreview.device` / `LaunchPlan.device` 不再代表最终参数；设备存在检查、组合记忆、逐卡估算都拿到自动单卡。

**独立纯函数夹具：** 两张 GPU，CUDA0 总量 24000 / 空闲 20000 MiB；CUDA1 总量 32000 / 空闲 4000 MiB。表单自动，额外参数如下：

```text
--device CUDA0,CUDA1 --split-mode layer --tensor-split 1,1
```

实际输出：

```json
{
  "finalDeviceFlag": "CUDA0,CUDA1",
  "previewDevice": "auto",
  "planDevice": "auto",
  "requiredDevices": [],
  "combo": null,
  "estimatedDevices": [{ "id": "CUDA1", "share": 1 }]
}
```

更窄的输入只手写 `--device CUDA0,CUDA1` 时，自动选卡后重拼参数，最终命令得到 `--device CUDA0,CUDA1 --split-mode none`：自动单卡的 pin 参数被混入用户设备组。

**影响：** 两卡预算变成一张卡，可能错误拒绝能放下的组，也可能漏掉另一张卡的压力；逐卡统计只采样错误集合，归属和看门狗候选池也随之失真；只覆盖设备的用户意图会被隐式生成的单卡模式改变。不存在设备的检查也被跳过。

**建议：** 从最终参数解析有序设备集合，显式区分“没有设备参数”和“设备参数指定了组”，让检查、预算、统计使用同一结果。自动选卡不能把显式设备组再次视为 auto；补完整 preview→plan→deviceInputs 的测试，不能只断言参数字符串里有逗号。

### MGPU-003 · major · 切分参数覆盖只更新命令，没有更新能力与组合校验

**位置：** `server/core/launch.ts:294–303`；预览同类路径在 `:220`。

`overridden` 只比较设备字符串；组的 `splitMode`、组合键和 `comboWarnings()` 始终取原 `sel.group`，不读取最终 `--split-mode`。额外参数修改模式但没有修改设备时，元数据与命令产生分歧。

**独立夹具结果：**

1. 表单 CUDA0/CUDA1 + layer，额外参数 `--split-mode row`：最终命令为 row，`plan.group.splitMode` 和 `combo` 仍为 layer；警告只有额外覆盖警告，没有实验模式未确认警告。
2. 表单 tensor，额外参数 `--split-mode layer`，运行库能力只有 layer：最终本应运行合法的 layer，`resolve()` 却抛 `split-mode-unsupported`，预览也根据被覆盖的 tensor 报错。

**影响：** 合法覆盖会被拒绝，实验或不支持的最终模式会逃过对应校验；修复 MGPU-001 后若仍沿用这份 plan，失败还可能记在错误模式下。额外参数为准是决定 45 已明确的行为。

**建议：** 与 MGPU-002 一起建立最终 GPU 配置解析结果，模式支持、确认、失败键均取最终模式和最终有序设备。覆盖比例 / 主 GPU 后也应校验它们是否与最终设备列表匹配；不能用表单组替代最终命令组。

### MGPU-004 · major · 逐卡预算忽略 split mode 与 main GPU

**位置：** `server/core/model-check.ts:54–55`、`:154–172`、`:220`；`server/core/memory-estimate.ts:276–306`。

`FinalParams` 只读取 `tensorSplit`，没有 `splitMode` / `mainGpu`；`EstimateParams` 也没有两者。`modelParts()` 总按 `assignLayers()` 将每层权重和 KV 放到拥有该层的卡，所有模式都采用 layer 假设。

本仓库调研已说明 row 的主 GPU 放中间结果与 KV，tensor 是张量并行。独立核对了项目记录的 llama.cpp commit `7fe450e19`：其 [参数源码](https://github.com/ggml-org/llama.cpp/blob/7fe450e19/common/arg.cpp#L2746-L2755) 明确 row 的 main GPU 承担 KV 和中间结果；[官方多 GPU 文档](https://github.com/ggml-org/llama.cpp/blob/7fe450e19/docs/multi-gpu.md) 区分 layer 的逐层 KV 与 tensor 的跨卡张量 / KV 切分。这里是源码契约证据，未运行该二进制。

**独立纯函数夹具：** 合成 8 层 llama、f16 KV、8192 上下文、两卡 1:1。layer、row/main=0、row/main=1 三次输出完全相同：CUDA0 和 CUDA1 各 128 MiB KV。改变主 GPU 对估算没有任何影响。

**影响：** row 主卡的 KV 可以被低估，另一卡被高估；tensor 的切分也被建模为离散层分配。该公式返回普通 tier，供 `admitTarget()` 决定放行 / 拒绝，再把其池用于统计和看门狗。`unverified-multi-device` 提示不能使忽略已知模式语义的预算变得可靠，尤其首次加载还没有实测可替代。

**建议：** 将最终模式和主 GPU 索引传入预算，按相应模式分配已知部分；不能可靠估算的模式或构建应明确给出 unknown 或有依据的保守上界。分别补 row 主卡变化、tensor 非均匀层 / 比例、额外参数 `none` + main GPU 的逐池边界测试。具体缓冲开销仍需多卡真机校准，不应把本夹具数值当作实测占用。

### MGPU-005 · minor · 更换组合不会重新触发首次确认

**位置：** `app/components/DeviceChoice.vue:60–68`、`:73–88`；`app/utils/gpu-choice.ts:52–59`。

确认只由 `pickMode()` 发起。确认一个 row / tensor 组合之后，勾选另一张卡或更换运行库，watcher 仅 GET 新组合状态，不调用 `ask()`；`toggleDevice()` 保留实验模式。新组合 `confirmed: false` 也不会弹确认，保存条件未要求其确认完成。

**证据层级：** 组件控制流静态核对 + 纯函数夹具。已确认的 CUDA0/CUDA1 + row 加入 CUDA2 后，表单仍为 row，但设备组变为三卡，组合键随之改变。没有执行浏览器点击，不能声称已完成弹窗端到端验证。

**影响：** “每个运行库 + 设备组 + 模式首次使用确认”只覆盖用户重新点模式的路径；修改组成部分可以绕过。计划允许服务端启动只警告，不建议借修复擅自改变为服务端硬阻断。

**建议：** 以整个组合为确认状态的依赖，组合变化后对未确认实验组合发起确认；确认结果、异步请求和实际接受的组合必须一致。补“确认 row 后换设备组 / 换运行库”的界面测试。

### MGPU-006 · minor · 显示名称不能作为构建身份

**位置：** `server/core/launch.ts:82`；`server/core/runtimes.ts:321`；确认 API 的键由 `server/service/context.ts:652–655` 生成。

`runtimeKeyOf()` 只有 `${accel}:${label}`。官方 label 是 tag，但自定义 label 是用户输入；注册只保证 id 唯一，不保证 label 唯一。两份自定义构建可使用同一个 label，甚至与官方 tag 同名。

**独立纯函数夹具：** `chooseExe()` 分别解析 `custom:r1`（tag b1）和 `custom:r2`（tag b2），得到不同 exe / ref，两者 label 都为 same。`runtimeKeyOf()` 都返回 `cuda:same`，因此相同设备组和模式的持久化键相同。

**影响：** 构建 B 继承构建 A 的确认或失败状态，首次确认可能被跳过，失败警告可能误报；“按运行库组合记录”的边界不成立。

**建议：** 使用稳定的实际运行库身份（官方渠道 + tag；自定义 id / 构建摘要），而非显示名称；读取已有记录时避免把旧的歧义键当作新构建已确认。补同 label 的不同运行库互不影响的测试。

### MGPU-007 · minor · 在线归属把“当前配置”当成“当前进程”

**位置：** `app/utils/memory-check.ts:176`；调用 `app/pages/index.vue:39`，数据来自 `server/service/model-check.ts:34–46`。

`modelsOnCard()` 根据当前 `checkProfile()` 的预算池标卡。检查使用目前保存的模型 / 方案 / 全局配置，没有读取运行实例加载时的设备快照。页面支持保存但不重启，运行进程与保存配置可以不同。

**独立真实 context / 假服务子进程夹具：** 在 CUDA0 配置下启动并进入 ready，再把同一方案保存为 CUDA1，不重启；对原方案重新检查。

```json
{
  "state": "ready",
  "pidUnchanged": true,
  "runningArgs": { "--device": "CUDA0", "--split-mode": "none" },
  "beforeEstimatePools": ["CUDA0", "host"],
  "afterEstimatePools": ["CUDA1", "host"]
}
```

结合 `modelsOnCard()` 的纯函数夹具，模型名从 CUDA0 消失并出现在 CUDA1；实际进程仍使用原 CUDA0 参数。没有运行浏览器，但已验证页面所用数据和归属函数。已有在线集合签名不会因纯配置保存立刻刷新，所以界面可能先保持旧缓存，在后续在线集合变化触发重算时再误标。

**影响：** GPU 卡片上的在线模型名误导用户判断是哪一个模型占卡；这里没有证据证明看门狗也在保存时换池，scheduler 候选池来自加载时 admission，不与此界面缺陷混为一谈。

**建议：** 在线归属使用运行实例加载时保存的最终设备 / 池快照；编辑和下一次加载的预算继续使用当前配置。补保存设备、改变全局继承值但不重启、再重启后的归属测试。

## 已核对的正常路径与剩余未知

- 三层表单配置采用“首个有选择的层整体生效”，单卡或显式 auto / cpu 可覆盖下层组，不会混用下层比例；旧单设备字段兼容、保存新选择清除旧组字段的测试通过。
- 表单组拒绝重复设备、auto / cpu 入组、不匹配比例、全零比例和越界主 GPU；复选辅助函数保留至少一张，设备变化清除旧比例 / 主 GPU。Mac 表单配置忽略 / 保存拒绝的构造测试通过。
- 未覆盖额外参数时，已读到的设备列表能拒绝缺失设备；`--help` 解析和按 exe 的模式缓存、未知探测不强制阻断等测试通过。未知探测放行是现有计划选择，不作为本轮问题。
- `SplitStats` 本身的原子存储、备份、重读、记录裁剪和成功清理有夹具测试；问题在真实失败接线，而非声称存储类完全不可用。
- 表单普通 layer 设备组可进入逐池预算；旧 CR-001 至 CR-009 的相关全套回归仍通过。本轮未改动这些修复，不将其计入新问题。
- CUDA 设备序号与 nvidia-smi index 的身份映射没有真机核对（特别是重排可见设备的环境）；当前实现有按 index 关联的路径，不能从假列表证明物理卡身份正确。
- 真正多卡切分、比例实际效果、跨卡缓冲、draft / mmproj 实际放置、运行期压力与性能均 unknown；没有把上游文档或假进程当作本机推理验收。

## 实际验证与清理

| 命令 | 结果 / 层级 |
| --- | --- |
| `git status --short`、`git log -10 --oneline`、`git rev-parse HEAD` | 核对基线及已有报告改动。 |
| `bun test tests/core/multi-gpu.test.ts tests/core/device-launch.test.ts tests/core/model-check.test.ts tests/core/memory-estimate.test.ts tests/app/gpu-choice.test.ts tests/app/memory-check.test.ts` | 退出码 0；136 pass、0 fail，760 断言，约 0.257 秒；构造配置 / 设备 / GGUF 事实测试。 |
| `bun .local/audit-mgpu.ts` | 退出码 0；两次独立运行。纯函数复现 MGPU-002 / 003 / 004 / 006，设备变更辅助函数复现 MGPU-005 的保留模式；第二次扩展了真实 context / Runner 假子进程，复现 MGPU-001 和 MGPU-007。临时脚本已删除。 |
| `bun test` | 退出码 0；1322 pass、20 skip、0 fail；1342 项、95 文件，5949 断言，约 25.76 秒。跳过项包括 Windows 进程树 / CMD / 缺失设备保存等平台限定用例。 |
| `bun run typecheck` | 退出码 0，通过。 |
| `bun test tests/core/multi-gpu.test.ts`（删除复现脚本后的检查） | 退出码 0；32 pass、0 fail，169 断言，约 0.255 秒。 |
| `git diff --check` | 退出码 0；最终状态只增加本报告，保留原有三份报告状态。 |

**未运行：** build、真实 llama.cpp / GPU 推理、Windows、多卡真机、浏览器交互。历史交接记录的单卡 5090 测试仅作为背景，没有在本轮重跑，不作为本轮通过的证据。

独立复现只写合成临时 settings / models / runtime 文件和 GGUF，设备读数是桩数据；Windows 平台被替换，进程实际在 macOS 上由 Bun 运行。真实 Runner 的端口范围为临时 17100–17109，进程 PID 均记录并确认退出；context 已 shutdown，临时目录已删除，环境变量及全局 context 覆盖在脚本 finally 中恢复。没有读取真实 `data/` 或 secrets，没有运行真实 llama-server、占用 GPU 或下载安装运行库。

本报告是唯一保留的本轮交付物。建议先修 MGPU-001 至 MGPU-004，再按每条原触发条件复审；本轮没有代为修复或进入下一批开发。
