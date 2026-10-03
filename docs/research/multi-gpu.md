# llama.cpp 多 GPU 调研

调研日期：2026-10-03  
范围：llama.cpp CUDA 后端、Windows 11 + NVIDIA、接入 llama-web 的方案。只调研，没有改代码或计划。

## 摘要

- CUDA 多 GPU 是 CUDA 后端提供的模型切分 / 并行能力，主要由 `--device`、`--split-mode`、`--tensor-split` 和 `-ngl` 等运行参数决定；不是只开一个环境变量就能获得多卡并行。
- **是，官方 Windows x64 CUDA Release 的基础多 GPU 支持随 CUDA 后端提供，不需要另开一个 multi-GPU 编译选项。**前提是下载 CUDA 资产，而不是 CPU 包。当前本机 `llama-server` 是 `0.5.0-dev`（build 11146，commit `7fe450e19`），其 `--help` 已列出 `none/layer/row/tensor` 和设备参数。官方 b11364（2026-10-03）发布 Windows x64 CUDA 12 / CUDA 13 包。NCCL / P2P 等可选通信能力、某个模式 / 架构是否能运行，仍需按具体二进制检查，不能仅凭包名推断。
- 必须把模型放进显存时，多卡的首要价值是容量。单卡能放下时，多卡可能提升，也可能因卡间通信、流水线空泡和较慢 GPU 而变慢；不能把显存相加当成速度线性增长。
- 计划阶段 8 的决定 39 规定一个模型只选一个设备；这覆盖单 GPU / CPU 选择，不能表达 GPU 集合、切分模式或分配比例。建议阶段 8 增加独立的多 GPU 工作包，放在单设备发现 / 选择之后、阶段 9 显存估算之前。这里不改 `plan.html`，留待用户决定。
- 本机 `llama-server --list-devices` 只发现一张卡：NVIDIA GeForce RTX 5090，32579 MiB 总显存、30991 MiB 空闲。**本机没有多卡，无法实测多 GPU 吞吐或互联。**这条命令只列设备，没有加载模型。

## 1. 多 GPU 由什么实现，Release 默认是否带

CUDA 多 GPU 由 `GGML_CUDA` 后端枚举 / 使用可见 CUDA 设备，再由 llama.cpp 参数决定设备与分配方式。模型切分能力不是单独的 `--enable-multi-gpu` 开关；CUDA 构建是前提，运行时参数决定用哪张 / 哪几张卡，以及如何切分。官方构建文档把 CUDA 构建写为 `-DGGML_CUDA=ON`；没有 CUDA 后端的 CPU 包不会因加了 `--split-mode` 就获得 CUDA 多卡能力。

官方 Release 列出 Windows x64 CUDA 12 和 CUDA 13 包。当前本机的 `0.5.0-dev` build 11146 的 `--help` 支持 `--device`、`--list-devices`、`--split-mode {none,layer,row,tensor}`、`--tensor-split`、`--main-gpu`，本机 RTX 5090 也被 CUDA 后端枚举。这证明**当前安装的具体二进制**带这些接口；只通过一张 GPU 无法确认跨卡通信、NCCL、各架构 tensor 模式是否可用。

当前官方 `docs/multi-gpu.md` 的参数说明适用于仓库当前主线，不等于 build 11146 的逐项保证。官方 Windows Release 二进制随构建持续变化，下载后应以该 exe 的 `--help` 和启动日志为准。尤其不要假设 CUDA Release 自带 NCCL 或启用了 CUDA P2P：官方指南称 NCCL 是构建时选择的能力，并说明缺 NCCL 会有性能警告；P2P 是运行时可选项且需硬件 / 驱动 / 主板支持。

来源：

- [llama.cpp README：后端和 CUDA](https://github.com/ggml-org/llama.cpp/blob/master/README.md)
- [llama.cpp 构建文档：CUDA 构建参数](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
- [官方多 GPU 指南](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md)（主线文档，调研日访问）
- [llama-server 参数参考](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [官方 Release b11364](https://github.com/ggml-org/llama.cpp/releases/tag/b11364)（2026-10-03，页面列有 Windows x64 CUDA 12 / CUDA 13）

## 2. 参数、默认值、使用场景和陷阱

| 参数 | 官方当前主线说明 / 默认值 | 作用与建议 |
| --- | --- | --- |
| `--device CUDA0,CUDA1` / `-dev` | 默认自动选择；逗号分隔设备名；`none` 表示不 offload。名称用 `--list-devices` 查 | 限定本次运行可用于 offload 的设备；顺序也决定 `--tensor-split` 比例的对应顺序。传入设备列表不等于一定按预想使用，需结合 split mode、`-ngl` 和启动日志。适用于显式设备组 / 避开某张卡。 |
| `--list-devices` | 打印可用设备和显存后退出 | 只读探测，可在阶段 8 缓存发现结果；限时执行，缓存必须按运行库版本区分。不可把一个版本发现的设备名称未经验证用于另一个版本。 |
| `--split-mode none` | `layer` 是默认值；`none` 只用一张 GPU | 单卡路径；以 `--main-gpu` 指定索引。阶段 8 的“选择一张 GPU”可映射到 `--device <GPU> --split-mode none`，但真实版本仍需核对组合。 |
| `--split-mode layer` | 默认；按连续层分卡，KV cache 跟随其层；pipeline parallel | 最兼容的多卡起点，适合扩显存，跨 GPU 通信相对少；一轮中的不同层位于不同卡，卡速差异 / 层负载不均可能形成流水线空泡。官方将其描述为更利于 batch throughput。 |
| `--split-mode row` | 官方主线列出，但标为 Deprecated；旧 row-split 路径 | 老的按权重行切分方式，性能通常不如新的 tensor 模式；除旧模型 / 特定实测兼容需求外，不建议作为新 UI 默认。官方当前 guide 的模式表已不把 row 列为推荐选项，但 `llama-server --help` 仍列出。 |
| `--split-mode tensor` | Experimental；分权重和 KV，多个 GPU 并行计算各层 | 对 token latency 有潜在好处，但每层需跨卡协作，互联速度影响大。当前官方指南说明架构覆盖不全；需要 Flash Attention，KV 仅允许非量化类型 `f32/f16/bf16`；量化 KV 会报错。此模式不支持 `--fit`，需要手动控制 `ctx-size`、并行槽和 GPU 层，OOM 风险更直接；应高级选项、实验标记，并先做质量 / 性能验证。 |
| `--tensor-split 3,1` / `-ts` | 比例逗号串；缺省随模式而不同 | 控制各设备分配比例，按 `--device` 顺序；`3,1` 等同 75:25。layer/row 缺省按可用显存自动切；tensor 缺省均分张量片段。不同显存 / 卡速混用时可手调。参数名虽叫 tensor-split，也会影响 layer 路径的设备分配。 |
| `--main-gpu 1` / `-mg` | 默认 0 | `none` 模式选唯一使用的 GPU；row 模式选放中间结果和 KV 的卡。**不是**多卡组的主卡 / 优先卡参数，不能替代 `--device` 或 `--tensor-split`。 |
| `-ngl all` / `-ngl N` | 当前主线默认 `auto`；允许整数、`auto`、`all` | 允许放进 VRAM 的层数上限。`all` 或旧用法 `999` 尽可能将层放 GPU；较低值可腾显存或将其余层留 CPU。`-ngl` 本身不选择多卡，也不保证模型权重 / KV / 计算缓冲装得下。llama-web 当前全局默认 `gpuLayers: 999`，会覆盖 llama.cpp 的默认。 |
| `CUDA_VISIBLE_DEVICES=1,0` | CUDA 环境变量；未设置则所有设备可见 | 进程级隐藏 / 重排 CUDA 设备，CUDA runtime 会按给定顺序重新编号。例如设成 `2,1` 后，应用内 device 0 对应物理 GPU 2。它影响此进程中的其他 CUDA 使用者，并会改变 `CUDA0` 编号；llama-web 管理方案宜优先用 `--device`，避免用全局环境变量做持久的用户偏好。 |
| `GGML_CUDA_P2P=1` | 默认不启用 | 请求 CUDA GPU 之间直接 P2P 访问，可能避免经主机内存中转；需要平台支持。官方警告某些主板 / BIOS（例如 IOMMU 配置）可能崩溃或结果损坏。除经用户同意做过目标机稳定性验证，不建议自动设置。 |
| NCCL | 构建期能力，不是运行时 flag | 官方主线文档称 tensor 模式有 NCCL 时会自动用于跨卡 reduction；缺少时会提示性能次优。目标 Windows Release 是否带 / 可用须看该版本日志和构建。不要将安装 CUDA Toolkit 与 NCCL 可用性混为一谈。 |

NVLink / PCIe：tensor split 每层跨设备同步，带宽 / 延迟和 P2P 支持都很关键；PCIe lane 少、经芯片组连接或缺 P2P 会拖慢。NVLink 可提高两卡间带宽，但不保证线性提速，也不能合并显存成一块连续内存。layer split 主要跨层传递激活，通信相对少，通常对慢互联更宽容。具体机器要查 GPU 拓扑、PCIe lane 和 P2P 状态并测，不能只看“插了 NVLink 桥”。

## 3. 速度：哪些已有实测，哪些是推断

### 有实测依据

- llama.cpp 官方多 GPU 指南给出机制层面的性能判断：`layer` 将不同层放在不同 GPU，低通信开销、流水化，更倾向于提高批处理吞吐；`tensor` 每层跨 GPU 汇总，更倾向于降低单请求 token latency，同时更依赖互联。官方同时明确结果取决于 split mode 和互联速度，没有承诺“多卡总是更快”。
- 一组公开的第三方 CUDA `llama-bench` 实测（Llama 3.3 70B Instruct Q4_K_M，39.59 GiB；2× Tesla V100 PCIe 32GB；CUDA 12.2；llama.cpp build 9870 / commit `2d973636e`；`pp512` / `tg128`）比较两种**多卡模式**：`layer` 349.39 / 15.98 t/s，`tensor` 524.58 / 26.11 t/s；开启 P2P 后分别为 349.23 / 15.99 与 524.02 / 26.19 t/s。此样本中 tensor 比 layer 的 prompt 处理约高 50%，生成约高 63%；P2P 开关几乎没有变化。它没有单卡基线（模型权重也大于单张卡的容量），不能用来证明多卡相对单卡更快。
- 官方仓库 issue 的双 RTX 3090 / Qwen3.6-27B MTP 记录指出，在 layer split 下，将 input embedding 从 CPU 移到第一张 GPU 后，prefill 测得依 prompt 长度提高 1.5–3 倍。这说明 prefill 对图分段 / CPU↔GPU 交界敏感，是特定 bug / 优化测量，不是多卡普遍加速比。

参考实测：[双 V100 的 llama.cpp layer / tensor / P2P 对照](https://www.reddit.com/r/homelab/comments/1vfapli/llamacpp_multigpu_benchmark_cuda_p2p_vs_layer_vs/)、[双 RTX 3090 prefill issue](https://github.com/ggml-org/llama.cpp/issues/22926)。前者是作者自报实测，版本、设备、模型和 llama-bench 参数可见；不是官方实验室测量。后者为官方项目 issue 中的开发者实测，不是正式基准报告。

### 推断（需在目标机器测）

- **模型单卡放不下：** 多卡可以把权重和部分 KV 留在 GPU，避免退回系统 RAM / CPU；首要收益是“能跑”及可能减少 CPU offload 的性能损失。仍须给 KV、计算缓冲、CUDA context 等留空间；几张卡的标称显存简单相加不等于可用容量。
- **模型单卡放得下：** 强制拆分通常没有容量必要。layer 模式不必然加速短对话 / batch=1 生成，流水线可能欠填；tensor 模式每层多卡协作，足够快的互联和可用架构下可能降低延迟 / 提升吞吐，但通信和同步也可能超过算力收益。把完整模型固定到单卡通常是性能基线。适合按工作负载做 `llama-bench` A/B，而非默认启用。
- **Prompt processing（prefill）：** 大 batch / 长 prompt 的矩阵计算较容易吃满多卡；layer pipeline 需足够 token 才能填满流水线。小 prompt 启动和跨卡成本可能占比高。tensor 也可能更快，但依赖 GPU 计算、PCIe/NVLink 和内核实现。不能简单断言 prefill 一定受益。
- **Token generation（decode）：** 单请求每步 batch 小，layer 模式是依次走层，流水线并行空间有限；tensor 模式可分摊每层工作、潜在降低延迟，但逐层通信对 PCIe 更敏感。更快的卡 + 慢卡混用可能因慢卡拖住整步而反效果。
- **服务吞吐与单用户速度不同：** 多并发请求 / 大 batch 能使 pipeline 更饱和；llama-web 阶段 9 同时做多个独立模型共享 GPU 时，还会有 GPU 算力争用和内存带宽争用，单看 `--tensor-split` benchmark 不能推断服务场景。

## 4. 不同显卡 / 显存混用时的分配

`--tensor-split` 的数字是比例而不是 MiB，也不是按理论 FLOPS 自动平衡。先确定 `--device` 顺序，再依次指定比例。对相近卡可从 `1,1` 起；不同可用显存可先用各卡**可分给该模型的预算**作为比例近似，例如预算约 18 GiB 和 12 GiB 可先试 `3,2`，而不是因为卡标注 24 GB 和 16 GB 就机械地填 `3,2`。必须从每卡可用显存中扣除当前其他进程、显示占用、KV / context、batch / ubatch 计算缓冲、CUDA context、安全余量。layer 分层是离散层且各层 tensor 大小不完全相同，比例只近似；tensor 模式有其架构 / buffer 限制且不支持 auto-fit。

显存比例与速度比例也不是一回事。异构卡应先保证容量，再通过分模式和比例 A/B 调整；给较慢卡分太多可能限制每 token 的进度。实际流程建议：先 `--list-devices`；按容量估一个保守比例；小上下文启动验证每卡占用和完整输出；逐步提高 context / batch；对典型 prompt 和生成长度跑多轮 `llama-bench`，分别记录 `pp` / `tg`、峰值显存和错误。保存的比例应与设备顺序绑定；设备换序或配置丢卡时不可静默重排比例。

## 5. 接入 llama-web：与阶段 8、9 的关系

### 当前实现检查

- `server/core/args.ts`：目前只有 `ctxSize`、KV 类型、flash attention、GPU layers、batch / ubatch、parallel、reasoning 等表单参数，没有受管理的 `device`、`split-mode` 或 `tensor-split` 字段。额外参数可传 `--split-mode`、`--tensor-split`、`--main-gpu`，别名 / 重复参数识别已含这三种；`--device` 当前不在重复检查别名表中。额外参数按全局 → 模型 → 方案追加，较后者覆盖前者；同一层重复才警告。
- `server/core/gpu.ts`：用 `nvidia-smi` 采样 NVIDIA GPU index / 名称 / 已用与总显存 / 利用率，未检测设备名称、CUDA 编号映射、设备 UUID、PCIe / NVLink 拓扑或 `llama-server --list-devices`。当前它是显存条采样，不是 llama.cpp 设备发现。
- `docs/plan.html` 阶段 8 决定 39：设备清单计划从所选运行库的 `llama-server --list-devices` 获取，配置方案 / 模型仅能选一个 GPU，CPU 对应 `--device none` 和 0 GPU layers，手写多设备 / `--tensor-split` 发警告。因此它能覆盖单 GPU / CPU，**不能覆盖多 GPU 模型**。阶段 8 全局 `defaults` / `defaultsCpu` 是 GPU / CPU 参数默认，并非全局的设备组偏好。

### 建议的配置面

如用户决定支持，至少需要：

1. 把设备选择从“单个 id”扩成有区分度的枚举：自动（定义清楚是 llama.cpp 默认可见设备行为）、CPU、单卡、GPU 组。GPU 组保存稳定的设备标识和顺序，不只保存 `CUDA0,CUDA1` 这种可能随环境变化的序号。
2. 全局 GPU 默认、全局 CPU 默认继续分开。明确 GPU 全局默认是自动、指定单卡还是设备组；模型 / 配置方案可继承 / 覆盖它。设备集合、split mode 和比例是同一组配置语义，避免只覆盖 device 却沿用不匹配的 split / 比例。
3. 每方案提供默认安全的 `layer`（或明确的“沿用 llama.cpp 自动”），可选设备组和比例。`tensor` 放“高级 / 实验性”，需提示其不兼容的架构、Flash Attention、非量化 KV 约束和关闭 `--fit` 的后果；row 不建议进入主界面。
4. 命令预览显示最终 `--device`、`--split-mode`、`--tensor-split`、`-ngl`，而且预览需按具体运行库的 `--help` 能力校验。保存设备列表应对设备缺失报错，遵守决定 35/39“不自动换卡”。
5. 扩充重复 / 冲突检测：`--device` 加入 flag 规范化；额外参数里的 `--device` / `--tensor-split` / `--split-mode` / `--main-gpu` 与受管理表单之间提示冲突。重复检测本身只提示重复、不能假装验证了设备次序、设备可用性或模式兼容。若保留手写覆盖，预览必须展示最后实际生效的命令。

### 与阶段 9 的内存 / 多模型并行冲突

决定 41 目前说不同设备的模型可同时在线，同一设备共享显存；决定 42 按“目标设备当前可用量”判断。多 GPU 组使“一个模型属于一张卡”变为“一模型占用一个或多个设备的资源向量”。两个模型可能设备组完全相同、部分重叠或不重叠，不能只按主 GPU 判断可否共存，也不能把设备组显存求和后当成统一池。

估算 / 调度应逐设备计算：每张卡现有占用（`nvidia-smi` 的实时空闲已包含外部程序，但要避免把本机模型占用重复算两次）+ 在线 llama-web 模型已实测的逐卡增量 + 目标模型分布到该卡的权重 + 该卡 KV / workspace / mmproj / CUDA 固定开销 + 安全余量。多卡加载虽串行，已有模型仍占资源；预估和显存保护必须在每个目标设备维度检查。模型成功启动后记录每卡增量，阶段 9 决定 43 的单一“实际显存增量”结构需要变成 device → bytes 映射并绑定具体设备身份 / 运行库 / 模式 / 比例。

多 GPU 不会消除 GPU 算力争用：阶段 9 若允许两个模型同时使用同一卡，即便内存有余量，两者的 prefill / decode 也会互相争算力。建议先让每模型配置一个设备组，阶段 9 以资源向量拦截显存超限；“同卡并行吞吐 / QoS”另作体验指标，不能由现有容量门槛推断。阶段 8 的“一个模型只能跑在一个设备上”和阶段 9 的“不同设备模型可并行”需改成“一个模型绑定一个设备组，在线模型按设备组重叠关系检查资源”，且应把该核心行为更新留给用户审阅后决定。

## 6. 本机只读检查

- 版本：`llama-server --version` → `0.5.0-dev (build 11146, commit 7fe450e19)`；Windows x86_64。
- 命令：`llama-server --list-devices`。
- 输出：`CUDA0: NVIDIA GeForce RTX 5090 (32579 MiB, 30991 MiB free)`；共 1 张 GPU。
- 本命令未加载 GGUF，没有进行推理或速度测试；没有第二张 GPU，故本文没有本机多卡 / NVLink / PCIe 性能结果。

## 建议及待用户决定

**建议做多 GPU，但先作为显式高级功能，而非默认追求提速。**优先价值是模型容量扩展；单卡够用时把单卡作为可比较基线。初版支持 `layer` + 设备组 + 手动比例 + 命令预览 / 逐设备内存保护；`tensor` 可先以高级实验选项呈现或暂不进入普通用户界面，直到目标 Windows Release、模型架构、Flash Attention / KV cache 和 NCCL 条件逐项验证。不要自动设 `GGML_CUDA_P2P`。

**计划位置建议：**阶段 8 的决定 39 必须扩成“单设备 / 设备组选择”。在 8-3 单设备发现接口确定后，增加一个独立 8-x 工作包，完成多卡配置与真实 `llama-server --help` 参数组合验证，再进入阶段 9 的设备级显存估算。它与阶段 8 耦合，较开一个脱离阶段 8 的后续阶段更自然；阶段编号和范围由用户定。本次不修改 `plan.html`。

需要用户决定：

1. 自动模式要沿用 llama.cpp 的所有可见 GPU 默认，还是默认选单卡、只有用户明确创建 GPU 组才多卡？
2. 第一版是否只支持 `layer`（较稳、兼容优先），把 `tensor` 留在实验选项 / 后续包？
3. 多卡配置是只在每个模型 / 配置方案里选，还是也需要可配置的全局 GPU 设备组默认？建议至少允许模型和方案覆盖，并让全局默认明确可见范围。
4. 阶段 9 是否接受多模型 GPU 资源按每设备增量向量估算，并把 `vram-stats.json` 扩为逐 GPU 记录？

## 来源

- [llama.cpp README](https://github.com/ggml-org/llama.cpp/blob/master/README.md) — 后端说明。
- [llama.cpp multi-GPU guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md) — 模式、参数、限制、P2P / NCCL、调试建议（2026-10-03 主线版本）。
- [llama-server README / CLI reference](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) — 当前参数默认值与环境变量映射（2026-10-03 主线版本）。
- [llama.cpp build docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) — CUDA 编译与 GPU 架构。
- [llama.cpp Release b11364](https://github.com/ggml-org/llama.cpp/releases/tag/b11364) — 2026-10-03 官方预发布 Windows x64 CUDA 12 / CUDA 13 资产。
- [NVIDIA CUDA_VISIBLE_DEVICES 文档](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/environment-variables.html) — 可见 GPU 与枚举顺序。
- [llama.cpp issue #22926](https://github.com/ggml-org/llama.cpp/issues/22926) — 双 RTX 3090 layer split 下 prefill 图分段优化实测。
- [双 Tesla V100 `llama-bench` 对照](https://www.reddit.com/r/homelab/comments/1vfapli/llamacpp_multigpu_benchmark_cuda_p2p_vs_layer_vs/) — build 9870、CUDA 12.2、Llama 3.3 70B Q4_K_M 的 pp512 / tg128，作者自报实测；仅能用于特定硬件和模式对照。
