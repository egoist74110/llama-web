# 5-1 平台兼容基础

本工作包完成服务端兼容基础。Windows 上运行测试与构建；macOS 分支只用构造数据验证。**尚未在 Mac 真机验证进程、sharp、Metal / CPU 推理，不宣称 Mac 已支持。** 不包含桌面壳、安装包或 Release。

## 平台接口

- `platformInfo(os, arch, nvidia?)` / `detectPlatform()`：报告 OS、架构、加速候选、命令 shell 和验证标记。Windows 的 NVIDIA 探测失败返回 unknown，不能自动猜 CUDA；检测不加载模型。
- `runtimeTarget(info, acceleration)`：校验 Windows x64 CUDA / CPU、macOS arm64 / x64 CPU / Metal 组合。Windows ARM、Linux 不在本工作包支持范围。Intel Mac 自动选择 CPU；显式 Metal 仍需硬件实测。
- `targetKey(target)`：运行库目录标识。CUDA 保持既有“精确版本优先，否则同一主版本最新 minor，并要求匹配 cudart”规则。
- `extractArchive()`：系统 bsdtar 支持 zip、tar.gz、tgz；先检查归档名、路径、类型和链接，再解压，解压后再次检查实际链接边界。下载要求 GitHub SHA-256。每个解压工具调用最多 120 秒，取消 / 超时杀掉工具后等待关闭，再删除临时目录。只有完整安装后才原子改名。
- `stopProcessGroup()`：非 Windows 托管子进程采用独立进程组，TERM、最多 1.5 秒宽限、KILL。组首进程退出时仍处理组内后代。Windows 保留 `taskkill /T /F`。
- `processIdentityAsync()`：Windows 查询真实路径和 CreationDate；Mac 查询路径、lstart、PGID。查询限时、支持取消；路径或身份不可读时不授权残留清理。
- `acquireDataLock()`：在配置加载、PID 迁移、残留清理之前获取数据目录锁；源码版和未来桌面版使用相同协议。首实例存活则拒绝第二实例，关闭托管资源后才释放锁。

## 现有数据迁移

### settings v3 → v4

新增 `llamacpp.acceleration`：`auto | cuda | cpu | metal`。既有 v3 配置迁移为 `cuda`，保持此前 Windows 行为；保存前用 JsonStore 备份原始字节。`current`、`cudaRuntime`、模型目录、全局参数、模型覆盖与方案参数不改写。

新配置使用 auto；确认 NVIDIA 的 Windows 使用既有参数默认值，CPU / Mac 新配置不套用 CUDA 特定参数。Mac 默认值只经过构造测试，真机效果待验证。修改加速类型后须重启，手改配置沿用已有管理方式；模型参数仍按原有层级合并，显式参数可以覆盖新配置默认值。

### runtime

```text
runtime/llama.cpp/
  bNNNNN/                       # 旧 Windows CUDA 版本，原地保留
  win32-x64-cuda/bNNNNN/         # 新下载的 Windows CUDA 版本
  win32-x64-cpu/bNNNNN/
  darwin-arm64-metal/bNNNNN/
  darwin-arm64-cpu/bNNNNN/
  darwin-x64-cpu/bNNNNN/
runtime/cloudflared/
  cloudflared.exe                # 旧 Windows 副本，可复制到新目录
  win32-x64/cloudflared.exe
  darwin-arm64/cloudflared
  darwin-x64/cloudflared
```

llama.cpp 旧平铺目录只供 Windows x64 CUDA 使用；CPU 和 Mac 不扫描它。相同 tag 优先使用当前平台目录。更新、回退、在用保护和保留至少两个版本的规则保持不变；清理限制在对应平台与旧 Windows 兼容目录。cloudflared 的 Darwin tgz 下载后校验、解压并设置执行权限。

### PID v1 → v2 与锁

第一次读取旧 PID 文件时保留原始 `pids.json.v1.bak`，再原子写入 v2。新记录增加 `birth`、`ownerPid`，非 Windows 另有 `pgid`。异步身份探测期间先登记进程；其退出会取消探测，禁止晚到结果重新添加已删除的 PID。

残留清理要求记录路径、实际路径、启动身份匹配，并在杀进程前再检查身份；Mac 还要求托管组匹配。实际路径必须位于 runtime 内。旧记录缺少 birth、路径不可读、PID 被复用或组不匹配时跳过，不能把启动时的时间字符串当作系统身份。

锁在 `run/instance.lock/owner.json`，短期互斥目录为 `run/instance.guard`；PID 存活（包括疑似复用）时不会抢锁，已确认死亡的 owner 可以恢复。若进程恰在写 owner / 持有 guard 的极短窗口被硬杀，或锁文件损坏，启动会保守拒绝；须确认所有实例已退出后由用户处理该残留，不按超时盲删。旧版本程序没有此锁协议，应退出旧实例后再启动升级版。

## 生命周期与验证边界

下载、校验、解压失败只留下可重试状态，完整版本未发布；工作目录在 finally 清理。版本落盘后若配置保存失败，旧 current 仍可用，新版本可在下次启动对账。迁移备份失败时不覆盖旧文件。身份补写失败会终止对应子进程；停止等待身份探测结束。

自动更新仍只在启动时运行，模型上线数仍固定 1；调度、端口分配、请求转发、公网来源识别和鉴权不变。无采样时隐藏 GPU 卡片，Mac 设置页说明采样及真机验证缺失；POSIX 命令预览使用单引号保护替换与 shell 元字符，Windows 继续 CMD 格式。

验证包括三平台资产构造测试、缺资产 / 错架构 / 校验失败、临时目录清理、真实小 zip / tar.gz / tgz、解压取消 / 超时、进程组信号模拟、身份与路径不匹配、PID 复用、旧配置备份、旧 runtime 回退与平台隔离、真实第二实例拒绝及死 owner 恢复。Windows 构建产物另用假 llama-server 验证旧目录加载、转发、命令预览、SSE、父进程退出与锁恢复。

未运行 Mac 构建或真机，不使用 Windows node_modules 生成 Mac 产物；未加载真实模型或占用推理 GPU，未修改用户真实配置、Cloudflare 或已有运行实例。

## 8-6 补充：Mac 源码版收尾与验证范围

- 新增 `start.command`（对应 `start.bat`）、`osascript` 选择文件夹、扫描跳过 `._*` / `.DS_Store`、`~` 展开、界面文案审计（Mac 上不出现 GPU / 显存 / Metal / 盘符）、`.github/workflows/ci.yml` 的 macOS 作业。
- **runner 验证（作业写好，结果以 GitHub Actions 为准，本地 Windows 上没有运行过）**：`bun test`、`bun run typecheck`、`bash -n start.command`、下载真实 macOS 版 llama.cpp 并运行 `llama-server --version`。
- **未验证（仍需 Mac 真机）**：Metal 加载与推理、模型占用的统一内存、`osascript` 对话框与系统权限提示、Finder 双击 `start.command`、手动添加压缩包时的隔离标记 / 签名、`sharp` 的原生安装、进程树清理。
- 因此「不宣称 Mac 已支持」的措辞保持不变；README 把 Mac 源码版标为「尚未在 Mac 真机验证」。
- 桌面壳 / DMG / 发包不在阶段 8，须用户另行启动。
