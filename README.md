# llama-web

本地私有 LLM 控制台：一个 Nuxt + Bun 进程，自己启动 / 停止 / 切换 `llama-server.exe`，提供 OpenAI 兼容 API（`/v1/*`）和中文管理界面，可选通过 Cloudflare 隧道对外开放（带 API key）。

- 按请求里的 `model` 自动加载或切换模型，同一时间在线 1 个（排队切换）
- 请求预处理：图片压缩
- 扫描模型目录、读取 GGUF 元数据；每个模型可建多套参数方案（`名字:方案` 调用）
- 界面：总览 / 模型 / 日志 / 设置；实时速度、加载进度、显存、失败诊断
- 自动更新官方 llama.cpp（CUDA 构建），保留旧版本，界面一键回退
- 平台：Windows 11 + NVIDIA GPU。开发计划与决定见 [`docs/plan.html`](docs/plan.html)

## 安装

需要 [Bun](https://bun.sh)（装好后 `bun` 在 PATH 里）。不需要自己下载 llama.cpp：首次启动会从官方 Release 下载 CUDA 版（含 cudart）并校验 SHA-256。

```bash
bun install
```

## 启动

双击 `start.bat`（没有构建产物时会先安装依赖并构建）。关闭窗口或按 Ctrl+C 即停止服务并结束所有 llama-server。

```bash
start.bat          # 运行上次的构建
start.bat build    # 重新构建后运行
```

默认地址 `http://localhost:5001`（监听 `0.0.0.0`，局域网可访问，完整功能，不需要 key）。第一次打开会进入设置向导：添加模型目录并启用模型。

## 配置

所有配置在 `data/`（不会进入 Git；改目录用环境变量 `LLAMA_WEB_DATA`）：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 端口、模型目录、默认参数、调度、图片压缩、日志保留、llama.cpp 版本等 |
| `models.json` | 已启用的模型和参数方案 |
| `secrets.json` | API key 和隧道 token（明文保存；界面默认打码，不进日志和请求记录） |
| `templates/` | 自定义聊天模板 |
| `runtime/` | 下载的 llama.cpp 版本目录，以及隧道用的 cloudflared（`runtime/cloudflared/`） |
| `logs/` | 模型输出、事件、请求记录（请求记录不含对话内容） |

绝大部分设置可以在界面「设置」页修改。`autoUpdate`、`keepVersions`、`cudaRuntime` 目前只能手改 `settings.json`。配置文件写入是原子的并保留备份（`data/backups/`）。

### 客户端连接

OpenAI 兼容：Base URL 填 `http://<本机地址>:5001/v1`，`model` 填模型名（或 `名字:方案`）。局域网不校验 key，随便填一个即可。

## 公网访问（Cloudflare 隧道）

公网入口是独立的 `:8080`：只绑定 `127.0.0.1`，只开放 `/v1/*`，必须带 `Authorization: Bearer <key>`；管理界面和 `/api/*` 在这个入口上一律 404。隧道由 llama-web 自己启动和看管（`cloudflared`），你只需要在 Cloudflare 后台建一次隧道、把隧道 token 填到设置页。

1. **建隧道**（只需要一次，需要一个已添加到 Cloudflare 的域名）。设置页「Cloudflare 隧道」卡片里有带示意图的分步说明，要点是：
   - Cloudflare 后台 → Zero Trust → Networks → Tunnels → Create a tunnel → 类型选 Cloudflared，起个名字；
   - 下一页 Install and run connectors 里复制 token（以 `eyJ` 开头；整条 `cloudflared.exe service install eyJ…` 命令也行），**不要**在电脑上运行那条命令；
   - Public Hostname：填子域名和域名，Service 类型选 `HTTP`，URL 填 `127.0.0.1:8080`（和设置页「入口端口」一致）。
2. 「设置 → API key」新建一个 key（明文可在列表里再次查看，请妥善保存）。
3. 「设置 → 公网入口」：打开启用开关（域名可选，只用来显示客户端地址），保存即生效。
4. 「设置 → Cloudflare 隧道」：粘贴隧道 token 并保存，打开「由 llama-web 托管隧道」。状态变成「已连通」就可以用了。

cloudflared 的来源：优先使用本机已装的（PATH、常见安装位置），会复制到 `data/runtime/cloudflared/` 再从那里运行；本机没有就从官方 Release 下载并校验 SHA-256。隧道随 llama-web 启动和退出；意外退出会自动重试（token 无效不会重试，需要你改好后点「立即重试」）。token 保存在 `data/secrets.json`，通过环境变量交给 cloudflared，不出现在命令行、日志、事件和界面（界面只显示打码结果）。

验证：

```bash
curl https://<域名>/v1/models                                   # 401
curl https://<域名>/v1/models -H "Authorization: Bearer <key>"  # 200
curl https://<域名>/api/state                                   # 404
```

key 在界面里吊销后立即失效（返回 401）。

## llama.cpp 更新与回退

启动后会在后台检查官方最新版本：有新版就下载、校验、解压到新的版本目录并设为当前；网络失败只记事件，本次继续用旧版本。默认保留最近 2 个版本（正在运行的模型所在版本不会被删）。「设置 → llama.cpp 版本」可手动切换 / 回退（有确认框）；新版本加载模型失败时失败卡片会提示回退。切换版本不会重启正在运行的模型，卸载后再加载才使用新版本。

## 开发

```bash
bun run dev          # 开发模式（Node 开发服务器；没有公网入口）
bun test             # 单元测试
bun run typecheck    # 类型检查
bun run build        # 构建到 .output/
```

提交前检查（拒绝提交 `data/` 下的文件和疑似密钥：`sk-…`、长十六进制串、Bearer token）。每个克隆启用一次：

```bash
git config core.hooksPath scripts
```

确认是故意写的假值（测试夹具）时，在该行加标记 `pre-commit:allow`。

开发约定、目录说明见 [`AGENTS.md`](AGENTS.md)。
