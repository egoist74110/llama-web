# 公网访问（Cloudflare 隧道）

**中文** · [English](public-access.en.md) · 返回 [README](../README.md)


公网入口是独立的 `:8080`：只绑定 `127.0.0.1`，只开放 `/v1/*`，必须带 `Authorization: Bearer <key>`；管理界面和 `/api/*` 在这个入口上一律 404。隧道由 llama-web 自己启动和看管（`cloudflared`）。

所有公网相关的设置都在「设置 → 公网访问」这一张卡片里。没开启时只有一个「开启公网访问」按钮，点开后是分步引导：每一步都填好了默认值，确认「是，下一步」或「改一下」即可；任意一步可以「保存进度，稍后继续」（进度存在 `data/settings.json`，下次打开从这一步继续）。

| 步骤 | 内容 | 默认 |
|---|---|---|
| 入口端口 | 隧道转发到的本机端口 | 8080 |
| API key | 已有就沿用；没有就生成一个（明文只在这里显示一次，之后可在列表里查看） | 名称 `server-1` |
| 选择方式 | ① 一键完成（给 Cloudflare API token）② 在 Cloudflare 网页上自己建，粘贴隧道 token ③ 没有域名，用临时地址（方式 C，跳过 Cloudflare 步骤直接到「连接」） | 已存过 API token → ①；只存过隧道 token → ② |
| …… | 见下面方式 A / 方式 B | |
| 连接 | 打开公网入口和隧道托管，等「已连通」，自动检测一次，显示客户端地址和 key | |

完成后卡片变成总览：连通状态、客户端地址（隧道上所有指向本机入口的主机名）、「检测」、API key 列表、「再加一个地址」「重新运行引导」「关闭公网访问」，端口、隧道方式（自有域名 / 临时地址）、隧道协议（HTTP/2 推荐、QUIC 备用）、隧道 token、API token 等放在「高级」里。临时地址模式下总览会标明方式，隐藏「再加一个地址」和隧道 token。

「检测」由 llama-web 从本机不带 key 请求每个地址的 `/v1/models`：收到 401 说明整条路是通的；530 = 地址指向的隧道没有在线连接器（多半是 DNS 还指向另一条隧道），502 = 隧道到不了本机入口端口，解析不到 = DNS 没生效或被当前网络屏蔽（某些公司网络会屏蔽域名，可以再加一个域名）。

## 0. 先决条件：域名已接入 Cloudflare

隧道只能用**已添加到你 Cloudflare 账号、状态为 Active** 的域名（zone）。Cloudflare 通过「域名的 NS 指向 Cloudflare」确认域名归你所有，这一步只能你自己做：

1. Cloudflare 后台首页 → Add a domain，输入根域名（例如 `example.com`），选 Free 套餐；
2. Cloudflare 给出两个名称服务器（`xxx.ns.cloudflare.com`），到域名注册商后台把域名的 NS 改成这两个；
3. 等 Cloudflare 里该域名状态变成 Active（几分钟到 24 小时）。不允许修改 NS 的域名（部分免费二级域名）不能接入。

Cloudflare 不提供免费域名，也不能通过 API 代你注册；域名要从注册商获得（免费二级域名服务，或付费购买）。

## 方式 A：一键完成（推荐）

1. 创建 Cloudflare API token：右上角头像 → My Profile → API Tokens → Create Token → Create Custom Token。权限策略四条（新版界面每条只能选一种范围）：
   - Entire Account：Cloudflare One Connector: cloudflared · Write
   - Entire Account：Cloudflare Tunnel · Write
   - All zones：DNS · Read 和 Write
   - All zones：Zone · Read

   改已有 token 要点 Review token → Update token 才生效；Roll 之后要重新粘贴新值。
2. 引导的「Cloudflare API token」一步：粘贴后点「校验并继续」（会先向 Cloudflare 校验，缺权限会指出缺哪项）。已保存过就直接「沿用」。
3. 「地址」一步：选域名（只列出可用的 zone）、填子域名（默认 `llm`）。看不到任何域名时会显示「域名从哪里来」的说明，也可以改走方式 B。
4. 「预览并执行」一步：预览列出将要做的事：新建 / 复用隧道、入口规则 `子域名.域名 → http://127.0.0.1:<入口端口>`、新建或修改 DNS CNAME（`<隧道ID>.cfargotunnel.com`，代理开启）、保存隧道 token、打开公网入口和托管开关。
   - 默认沿用 llama-web 正在托管的那条隧道；已有同名隧道、或该地址的 CNAME 已指向别的隧道时，会列出现状让你选「复用」还是「新建 + 改指」；
   - 该地址已有 A / AAAA 等其他记录时不会继续（llama-web 不替你删记录），换个子域名或自己去后台删；
   - 复用的隧道上有其他在线连接器、或有其他主机名时会提示。
5. 确认执行。执行前会再读一次账号，情况有变就停下来让你重新预览；某一步失败可以「从失败处重试」，或「放弃并删除这次新建的内容」（只删这次新建的隧道 / DNS 记录）。用完可以在 Cloudflare 后台删掉 API token，已建好的隧道不受影响。
6. **再加一个地址**（例如某个网络打不开当前域名）：总览里点「再加一个地址」，选另一个域名再跑一次。只给当前隧道加一条入口规则和一条 DNS 记录，原来的地址照常可用。

## 方式 B：在 Cloudflare 后台手动建

1. 「在 Cloudflare 网页上建隧道」一步有带示意图的分步说明，要点是：
   - Cloudflare 后台 → Zero Trust → Networks → Tunnels → Create a tunnel → 类型选 Cloudflared，起个名字；
   - 下一页 Install and run connectors 里复制 token（以 `eyJ` 开头；整条 `cloudflared.exe service install eyJ…` 命令也行），**不要**在电脑上运行那条命令；
   - Public Hostname：填子域名和域名，Service 类型选 `HTTP`，URL 填 `127.0.0.1:8080`（和「入口端口」一致）。

   做完把你填的地址（`子域名.域名`）填回引导里。
2. 「粘贴隧道 token」一步：粘贴刚才复制的 token，下一步「连接」。

改了「入口端口」（「高级」里）之后，隧道的入口规则不会自动跟着改：用「再加一个地址」对同一个地址再跑一次一键完成，或到后台改 Public Hostname。

## 方式 C：没有域名，用临时地址（Quick Tunnel）

向导里选「没有域名，用临时地址」即可：不需要域名，也不需要 Cloudflare 账号，也不保存 token。连通后得到一个 `https://<随机词>.trycloudflare.com/v1` 地址，带 API key 使用。限制（向导里也会明说）：

- 每次启动隧道（重启 llama-web、关了再开、断线重连）地址都会变，客户端要换新地址；
- 流式输出可用：聊天请求（POST）实测逐条返回；但 Cloudflare 官方不支持 SSE，GET 形式的流式接口会被缓冲；
- 同时在途请求最多 200 个，超出返回 429；没有 SLA，只适合试用，长期使用请改自己的域名。

公网入口的规则不变：只绑 `127.0.0.1`、只开放 `/v1/*`、必须带 key。「高级」里可以随时在「自有域名」和「临时地址」之间切换（切回自有域名需要已保存隧道 token）。

临时地址模式不留 token、证书或账号信息：只用到 `data/runtime/cloudflared/` 下的 cloudflared 和一份空配置 `quick-tunnel.yml`，子进程记录在 `data/run/pids.json`。**卸载 / 清理：删除数据目录（`data/`）即可，`data/runtime/cloudflared/` 随之删除；关闭公网访问或退出 llama-web 时 cloudflared 进程会一起结束。**

cloudflared 的来源：优先使用本机已装的（PATH、常见安装位置），会复制到 `data/runtime/cloudflared/` 再从那里运行；本机没有就从官方 Release 下载并校验 SHA-256。隧道随 llama-web 启动和退出；意外退出会自动重试（token 无效不会重试，需要你改好后点「立即重试」）。token 保存在 `data/secrets.json`，通过环境变量交给 cloudflared，不出现在命令行、日志、事件和界面（界面只显示打码结果）。

验证：

```bash
curl https://<域名>/v1/models                                   # 401
curl https://<域名>/v1/models -H "Authorization: Bearer <key>"  # 200
curl https://<域名>/api/state                                   # 404
```

key 在界面里吊销后立即失效（返回 401）。

