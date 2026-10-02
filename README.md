# llama-web

本地私有 LLM 控制台：一个 Nuxt + Bun 进程，自己启动 / 停止 / 切换 `llama-server.exe`，提供 OpenAI 兼容 API（`/v1/*`）和中文管理界面，可选通过 Cloudflare 隧道对外开放（带 API key）。

- 按请求里的 `model` 自动加载或切换模型，同一时间在线 1 个（排队切换）
- 请求预处理：图片压缩
- 扫描模型目录、读取 GGUF 元数据；每个模型可建多套参数方案（`名字:方案` 调用）
- 界面：总览 / 模型 / 日志 / 设置；实时速度、加载进度、显存、失败诊断
- 自动更新官方 llama.cpp（CUDA 构建），保留旧版本，界面一键回退
- 平台：Windows 11 + NVIDIA GPU。开发计划与决定见 [`docs/plan.html`](docs/plan.html)

## 安装

Windows 桌面薄壳与本地 NSIS 测试包正在工作包 5-2 验收，尚未公开发布。构建方式、数据目录和已测 / 未测项见 [Windows 桌面记录](docs/windows-desktop.md)。源码版继续使用下述方式。

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
| `secrets.json` | API key、隧道 token、Cloudflare API token（明文保存；界面默认打码，不进日志和请求记录） |
| `templates/` | 自定义聊天模板 |
| `runtime/` | 下载的 llama.cpp 版本目录，以及隧道用的 cloudflared（`runtime/cloudflared/`） |
| `logs/` | 模型输出、事件、请求记录（请求记录不含对话内容） |

绝大部分设置可以在界面「设置」页修改。`autoUpdate`、`keepVersions`、`cudaRuntime` 目前只能手改 `settings.json`。配置文件写入是原子的并保留备份（`data/backups/`）。

### 客户端连接

OpenAI 兼容：Base URL 填 `http://<本机地址>:5001/v1`，`model` 填模型名（或 `名字:方案`）。局域网不校验 key，随便填一个即可。

## 公网访问（Cloudflare 隧道）

公网入口是独立的 `:8080`：只绑定 `127.0.0.1`，只开放 `/v1/*`，必须带 `Authorization: Bearer <key>`；管理界面和 `/api/*` 在这个入口上一律 404。隧道由 llama-web 自己启动和看管（`cloudflared`）。

所有公网相关的设置都在「设置 → 公网访问」这一张卡片里。没开启时只有一个「开启公网访问」按钮，点开后是分步引导：每一步都填好了默认值，确认「是，下一步」或「改一下」即可；任意一步可以「保存进度，稍后继续」（进度存在 `data/settings.json`，下次打开从这一步继续）。

| 步骤 | 内容 | 默认 |
|---|---|---|
| 入口端口 | 隧道转发到的本机端口 | 8080 |
| API key | 已有就沿用；没有就生成一个（明文只在这里显示一次，之后可在列表里查看） | 名称 `server-1` |
| 选择方式 | ① 一键完成（给 Cloudflare API token）② 在 Cloudflare 网页上自己建，粘贴隧道 token | 已存过 API token → ①；只存过隧道 token → ② |
| …… | 见下面方式 A / 方式 B | |
| 连接 | 打开公网入口和隧道托管，等「已连通」，自动检测一次，显示客户端地址和 key | |

完成后卡片变成总览：连通状态、客户端地址（隧道上所有指向本机入口的主机名）、「检测」、API key 列表、「再加一个地址」「重新运行引导」「关闭公网访问」，端口、隧道 token、API token 等放在「高级」里。

「检测」由 llama-web 从本机不带 key 请求每个地址的 `/v1/models`：收到 401 说明整条路是通的；530 = 地址指向的隧道没有在线连接器（多半是 DNS 还指向另一条隧道），502 = 隧道到不了本机入口端口，解析不到 = DNS 没生效或被当前网络屏蔽（某些公司网络会屏蔽域名，可以再加一个域名）。

### 0. 先决条件：域名已接入 Cloudflare

隧道只能用**已添加到你 Cloudflare 账号、状态为 Active** 的域名（zone）。Cloudflare 通过「域名的 NS 指向 Cloudflare」确认域名归你所有，这一步只能你自己做：

1. Cloudflare 后台首页 → Add a domain，输入根域名（例如 `example.com`），选 Free 套餐；
2. Cloudflare 给出两个名称服务器（`xxx.ns.cloudflare.com`），到域名注册商后台把域名的 NS 改成这两个；
3. 等 Cloudflare 里该域名状态变成 Active（几分钟到 24 小时）。不允许修改 NS 的域名（部分免费二级域名）不能接入。

Cloudflare 不提供免费域名，也不能通过 API 代你注册；域名要从注册商获得（免费二级域名服务，或付费购买）。

### 方式 A：一键完成（推荐）

1. 创建 Cloudflare API token：右上角头像 → My Profile → API Tokens → Create Token → Create Custom Token。权限三行：
   - Account · Cloudflare Tunnel · Edit
   - Zone · DNS · Edit
   - Zone · Zone · Read

   Account Resources 选你的账号，Zone Resources 选要用的域名（或 All zones）。
2. 引导的「Cloudflare API token」一步：粘贴后点「校验并继续」（会先向 Cloudflare 校验，缺权限会指出缺哪项）。已保存过就直接「沿用」。
3. 「地址」一步：选域名（只列出可用的 zone）、填子域名（默认 `llm`）。看不到任何域名时会显示「域名从哪里来」的说明，也可以改走方式 B。
4. 「预览并执行」一步：预览列出将要做的事：新建 / 复用隧道、入口规则 `子域名.域名 → http://127.0.0.1:<入口端口>`、新建或修改 DNS CNAME（`<隧道ID>.cfargotunnel.com`，代理开启）、保存隧道 token、打开公网入口和托管开关。
   - 默认沿用 llama-web 正在托管的那条隧道；已有同名隧道、或该地址的 CNAME 已指向别的隧道时，会列出现状让你选「复用」还是「新建 + 改指」；
   - 该地址已有 A / AAAA 等其他记录时不会继续（llama-web 不替你删记录），换个子域名或自己去后台删；
   - 复用的隧道上有其他在线连接器、或有其他主机名时会提示。
5. 确认执行。执行前会再读一次账号，情况有变就停下来让你重新预览；某一步失败可以「从失败处重试」，或「放弃并删除这次新建的内容」（只删这次新建的隧道 / DNS 记录）。用完可以在 Cloudflare 后台删掉 API token，已建好的隧道不受影响。
6. **再加一个地址**（例如某个网络打不开当前域名）：总览里点「再加一个地址」，选另一个域名再跑一次。只给当前隧道加一条入口规则和一条 DNS 记录，原来的地址照常可用。

### 方式 B：在 Cloudflare 后台手动建

1. 「在 Cloudflare 网页上建隧道」一步有带示意图的分步说明，要点是：
   - Cloudflare 后台 → Zero Trust → Networks → Tunnels → Create a tunnel → 类型选 Cloudflared，起个名字；
   - 下一页 Install and run connectors 里复制 token（以 `eyJ` 开头；整条 `cloudflared.exe service install eyJ…` 命令也行），**不要**在电脑上运行那条命令；
   - Public Hostname：填子域名和域名，Service 类型选 `HTTP`，URL 填 `127.0.0.1:8080`（和「入口端口」一致）。

   做完把你填的地址（`子域名.域名`）填回引导里。
2. 「粘贴隧道 token」一步：粘贴刚才复制的 token，下一步「连接」。

改了「入口端口」（「高级」里）之后，隧道的入口规则不会自动跟着改：用「再加一个地址」对同一个地址再跑一次一键完成，或到后台改 Public Hostname。

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
