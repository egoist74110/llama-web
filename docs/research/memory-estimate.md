# 显存 / 内存预估：核对与实测记录（工作包 9-1）

日期：2026-10-05  
范围：llama.cpp b11146（`darwin-arm64-metal`），Apple M4、16 GiB 统一内存。**只有 Metal / 统一内存口径被实测；CUDA（独立显存）路径没有实测**（这台机器没有 NVIDIA 卡），相关常数和行为在文末列为“未验证”。

模型（不进仓库，会话结束后删除）：

| 缩写 | 模型 | 架构特点 |
|---|---|---|
| smol | SmolLM2-135M-Instruct Q8_0（bartowski GGUF，145 MB） | 稠密，GQA，词表 49152 |
| gemma | Gemma 3 270M it Q4_K_M（unsloth GGUF，253 MB） | 滑动窗口（5 层窗口 : 1 层全局，窗口 512），词表 262144 |
| qwen35 | Qwen3.5-2B Q4_K_M + mmproj-BF16（用户自备） | 线性注意力 / 全注意力混合（每 4 层 1 层全注意力），带视觉投影器，词表 248320 |

## 怎么测的

1. **llama.cpp 自报的分项**：`llama-server -v` 在真实加载时打印 `model buffer`、`KV buffer`、`RS buffer`（循环状态）、`compute buffer`、`output buffer`。这是被预估的对象，逐项对比。
2. **整机口径**：`ioreg -c IOAccelerator` 的 `In use system memory`（Apple silicon 上整机 GPU 已分配内存）在加载前后的差，每个配置取 3 次中位数。进程级 `footprint` 看不到 Metal 缓冲（权重是映射文件），不可用。
3. `llama-fit-params -v`（不加载权重，只打印它自己的预测）用于核对 `--fit` 行为和做大量参数网格。
4. 隔离：每个进程用随机端口、参数数组启动，测完 `killpg` 结束整个进程树，没有动机器上其他 llama-server。

## 核对结论

**`--fit` / `llama-fit-params`**

- `llama-server` 默认开 `--fit on`、余量 1024 MiB / 设备。`llama-fit-params -v` 不加载权重就能打印 `memory breakdown`（model / context / compute），也能给出调整后的参数。
- **它不传 `-c` 时会静默缩小上下文**：Qwen3.5-2B（训练上下文 262144）余量 9000 MiB 时 `-c 262144 → 107264`，余量 11000 MiB 时 `-c 4096 -ngl 6`。显式传了 `-c` 时只降低 `-ngl`（11000 MiB：`-ngl 1`），不动上下文。本应用的默认参数总是传 `--ctx-size`，所以 `--fit` 的实际效果是“放不下就把层挪去 CPU”，而不是缩上下文。
- **它的计算缓冲偏大很多**：Gemma 3 270M ctx 8192 时 fit 报 513 MiB，真实加载只有 30.7 MiB（+11.5 MiB CPU）；因为它按“每个 token 都要 logits”预留。**所以不能直接把 fit 的数当作预估，以真实 llama-server 的日志为准。**预估没有调用 fit，是纯公式。
- Mac 上 llama.cpp 报的设备“可用”是 Metal 工作集上限（本机 12123 MiB，约 16 GiB 的 74%）减去**本进程**已分配，不含别的程序的占用，所以 Mac 的预算要另外和系统可用内存取较小值。

**`--parallel`（`-np`）对 KV 总量的影响**

- 不传（自动）：**4 个槽位，统一 KV（`kv_unified`）**——全注意力层总格数 = ctx，不放大；滑动窗口层格数 = `pad256(窗口 × 槽数 + ubatch)`；循环状态 = 槽数 × 单序列状态。
- 显式 `-np N`：非统一，每槽 ctx/N，全注意力层总量仍是 ctx；滑动窗口层 = N × `min(ctx/N, pad256(窗口 + ubatch))`；循环状态 = N × 单序列。
- 实测：Gemma 3 ctx 8192 滑动窗口层 np1 / 默认 / np4 = 15 / 37.5 / 60 MiB；Qwen3.5 循环状态 np1 / np4 = 19.27 / 77.06 MiB；SmolLM2 全部 180 MiB 不变。**注意本应用默认 `parallel = 1`，但 llama-server 自己的默认是 4。**

**K / V 缓存类型每元素字节**

f32 4、f16 2、bf16 2、q8_0 34/32、q4_0 18/32、q4_1 20/32、iq4_nl 18/32、q5_0 22/32、q5_1 24/32。实测 SmolLM2：f16 180、q8_0 95.62、q4_0 50.62 MiB，与公式一致（q8_0 = 180 × 17/32）。q4_1 / q5_x / iq4_nl / f32 / bf16 只用 llama.cpp 的块大小表推导，没有逐一加载过。

**flash-attn 对计算缓冲的影响**

关闭 FA 后多出一块注意力分数缓冲 ≈ `ubatch × 最大 KV 格数 × 注意力头数 × 4 字节`：SmolLM2 实测多 143 MiB（公式 151）、Gemma 61（64）、Qwen3.5 106（128）。FA 开时计算缓冲只随 ubatch 线性增长（SmolLM2 ub 128 / 512 / 2048：11.3 / 19.9 / 77.0 MiB）。

**几个对公式有影响的发现**

- Gemma 3 的词表很大（262144），计算缓冲里**没有** logits，`output buffer`（= 词表 × 4 B × 槽数，在内存里）是另一块：1 MiB × 槽数。
- 绑定输出投影（tied embedding，三个模型都是）：Metal 的 MTL 缓冲等于**全部张量字节**，CPU 缓冲（嵌入张量）是同一份映射的另一个视图，**不额外占内存**（Gemma：MTL 235.16 MiB = 文件张量总和，CPU 170.0 MiB = `token_embd` 字节）。独立显存的卡上则会多出一份输出投影副本（没有实测，按 llama.cpp 的源码行为写入公式，列为未验证）。
- 带 mmproj：权重 640 MiB（= 文件大小）+ 图片计算缓冲 256.4 MiB（MTL）+ 24.9 MiB（CPU），热身图 1472 × 1472。**只有一个样本**，公式取 `max(128, 0.4 × mmproj 字节)`。

## 公式（`server/core/memory-estimate.ts`）

- 权重：张量字节（按层），共享内存只算一次；有独立显存的卡 = 它的层 + 输出层（含绑定嵌入副本），嵌入留在主机。分片按总大小等比放大。
- KV：Σ 层 `kv头数 × (key长 × K字节 + value长 × V字节) × 格数`，层种类（全 / 滑窗 / 循环）来自 `block_count`、`sliding_window`、窗口模式（文件里的数字或数组；gemma2/3/3n、gpt-oss、cohere2 内置）、`full_attention_interval`、每层 KV 头数组。
- 循环状态：`((conv_kernel − 1) × (inner + 2 × group × state) + state × inner) × 4 B × 槽数 × 循环层数`（Qwen3.5 实测 19.27 MiB 与公式一致到 0.01）。
- 计算缓冲：`ubatch × (ffn宽 + 嵌入宽) × 20 B + 12 MiB`（+ FA 关时的分数缓冲）；主机侧 `ubatch × 0.032 MiB`；输出缓冲 `词表 × 4 B × 槽数`。
- mmproj、草稿模型、设备固定开销（独立显存 512 MiB，共享内存 0）另列。
- 三档：占预算 ≤ 85% 可以、≤ 100% 有风险、> 100% 放不下；**预算有一项读不到就是“未知”，不会判成放得下**（读得到的部分已经放不下时仍是“放不下”）。

## 误差（24 个真实配置：3 个模型 × 8 组参数）

对比 llama.cpp 自己打印的分项（权重 + KV + 循环状态 + 计算 + 输出缓冲）：

| | 偏差 |
|---|---|
| KV 缓存（全部 24 个配置，含 np4 / 滑窗 / 量化 / ubatch） | 0%（逐项一致，q8_0 / q4_0 差 < 0.01 MiB） |
| 循环状态 | 0%（19.27 / 77.06 MiB） |
| 计算缓冲 | +2% ~ +89%（全部偏大，绝对值 17–394 MiB；最初常数 8 MiB 时 ubatch 128 的两个配置低估 4 MiB，提到 12 MiB 后不再低估） |
| 总量 | 0% ~ +10%（没有低估） |

对比整机口径（`ioreg` 3 次中位数 vs llama.cpp 的 MTL 缓冲之和）：

| 配置 | MTL 缓冲之和 | 整机增量 | 偏差 |
|---|---|---|---|
| smol ctx 131072 np1 | 3246 MiB | 3352 | +3% |
| gemma ctx 131072 np1 | 905 | 938 | +4% |
| qwen35 ctx 65536 np1 | 2219 | 2398 | +8% |
| qwen35 ctx 8192 np1 | 1382 | 1460 | +6% |
| qwen35 ctx 8192 np1 + mmproj | 2279 | 2307 | +1% |
| gemma ctx 8192 np4 | 356 | 462 | +30%（总量只有 350 MiB，落在 ±100 MiB 的噪声里） |

小模型的整机口径噪声在 ±100–300 MiB（系统自己的活动，曾出现负增量），所以只在“大信号”配置上相信它；**预估的准确度主要由第一张表（对 llama.cpp 自己的分项）说明，第二张表说明分项加起来确实对应整机增量。**

## Mac / CPU 的可用内存口径

- `os.freemem()` 在这台 Mac 上只有 99 MiB（只数 free 页），不能用；`kern.memorystatus_level`（52%）含活动页，偏乐观。
- 采用 **free + speculative + inactive + purgeable**（`vm_stat`），不含活动页，是保守下界。真实加载时它的下降量（smol ctx 131072：2370 MiB；qwen35 ctx 65536：1704 MiB）小于真实占用（3352 / 2398），因为系统同时在回收活动页——**这个口径会低估“被占掉的量”，但作为“还能给多少”的上界，它不会把紧张说成宽裕**。Metal 缓冲在 `vm_stat` 里表现为 wired（增量 +3125 / +2157 MiB，对应真实 3352 / 2398，低 7–9%）。
- 系统余量沿用决定 44 的“总量的 15% 与 2 GiB 中较大者”。**这个值没有被实测证明也没有被推翻**（没有做让系统进入内存压力的测试）；9-3 的看门狗阶段再看。
- 预算 = min(设备工作集上限 − 已分配, 可用内存 − 余量)，由 `estimateMemory` 对共享内存设备做；纯 CPU 只看后者。

## 保存时检查：哪些组合“必然启动失败”（9-2，Mac b11146，Qwen3.5-2B Q4_K_M，`--device none -ngl 0`，只用 CPU、不占 GPU）

| 组合 | 结果 | 处理 |
|---|---|---|
| `-ctv q8_0 -fa off`（`-fa 0` 同） | 退出码 1：`quantized V cache requires flash_attn to be enabled` | **错误，拒绝保存** |
| `-ctv q8_0 -fa on` / `auto` / 不写；`-ctk q8_0 -fa off` | 正常启动 | 无 |
| `-c 400000`（训练长度 262144） | 正常启动，日志警告并把槽上下文截到训练长度 | 警告 `ctx-over-train`（有 rope / yarn 选项时不报） |
| `-b 256 -ub 512` | 正常启动 | 警告 `ubatch-over-batch` |
| `-ngl 99 --device none` | 正常启动（层数不生效） | 警告 `cpu-gpu-layers` |
| `-np 8 -c 512` | 正常启动 | 每槽 < 1024 token 时警告 `slot-ctx-small`（1024 是经验阈值，没有实测依据） |

另有两类错误不是这次测的：设备不在该版本的 `--list-devices` 里（8-7 在真实 RTX 5090 上看到 `invalid device`，退出 1；只按该版本自己的列表判断，列表读不到时不拒绝）、该版本 `--help` 里没有所选切分模式。显存 / 内存三档**永远不拒绝保存**：可用量随时在变，决定权在用户。

`--list-devices` 在 Mac 上除了 `MTL0` 还会列出 `BLAS: Accelerate (0 MiB)`，检查按总量最大的一项取 Metal 设备。

未验证：Windows / CUDA 上这些规则（`mlock` 对 `--load-mode mlock` 的识别按 `--help` 文字写成，没在 Windows 上跑）；`-ot` / `--n-cpu-moe` 不理解；`--fit` 开着时 llama-server 可能自己降层数而不是失败，所以“放不下”只是预估，不是必然失败。

## 没有验证的部分（如实）

- **CUDA / 独立显存**：nvidia-smi 的显存对比、设备固定开销 512 MiB（猜测值，偏大）、绑定嵌入在卡上的副本、多卡流水并行是否让计算缓冲翻倍、`row` / `tensor` 模式，全部未实测。Windows WDDM 下 `nvidia-smi` 取不到单进程显存、改用加载前后差值的做法，只有 `loadDelta` 的纯函数测试。
- **MoE 模型**的专家权重和计算缓冲、**MLA**（DeepSeek）的 KV、其他混合架构（Jamba、LFM2、nemotron_h 等）：只有按文件字段的通用公式，没有加载过；`unverified-moe-compute` / `unverified-mla` 在结果里标出。
- **草稿 / MTP 模型**的计算缓冲：按主模型同一公式，没有实测。
- 更大的模型（> 2 GiB）、带 `-ot` / `--n-cpu-moe` 之类额外参数的启动：公式不理解这些参数。
- **加载成功后的自动记录和“偏差大写事件”还没接到调度**（9-1 不改调度；`VramStats` 已可用，接线放 9-3）。
- 小于 12 MiB 的常数、系数 20 B / 0.4 都是用 3 个模型拟合出来的，**样本少**；预估总量用于三档判断时依赖“偏大”这一点，换架构后需要再对一次。

## 复现

`llama-fit-params -m <模型> -c 8192 -v` 看 fit 的分项；`llama-server -m <模型> -v ...` 在日志里看 `sched_reserve` / `llama_kv_cache` / `load_tensors` 行。测试里的“真实日志”数值（`tests/core/memory-estimate.test.ts`）就是这些输出的整理。
