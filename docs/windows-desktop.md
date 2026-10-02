# Windows desktop · 5-2 in progress

本地 Windows x64 测试包已生成；5-2 尚未完成验收，不进入 5-3 或 Mac。

## 构建

需要原生 Windows x64、Bun 1.3.14、Rust 1.99.0 MSVC、Visual Studio C++ Build Tools / Windows SDK、Git。Rust 和 Cargo 需在 PATH 上。WebView2 是应用运行要求，NSIS 使用 downloadBootstrapper 检查 / 安装；缺少时需要联网。当前测试包未签名，版本 0.0.0 仅供本地验证，不是 Release 版本。

```powershell
bun install --frozen-lockfile
bun run desktop:build
```

`desktop/prepare.ts` 在独立工作树构建 Nuxt，复制完整 `.output`、固定 Bun、数据导入助手和许可到生成目录 `src-tauri/resources/`。不读取 `data/`、`.env` 或真实 secrets，不改主目录 `.output`。安装包位于 `src-tauri/target/release/bundle/nsis/`。

## 生命周期和数据

- Rust 通过参数数组启动绝对路径的内置 Bun，并隐藏控制台。主服务仍读取既有 host / port；不自动换端口。
- ready / shutdown 仅使用继承的 stdin / stdout 管道，消息携带本次 UUID、协议版本和子进程 PID。HTTP 没有退出接口；现有页面没有 Tauri 原生权限。启动页独享状态、重试、退出和显式目录导入权限。
- 主窗口仅允许本次 `http://127.0.0.1:<port>` 来源；HTTP / HTTPS 外链交系统浏览器，其余导航拒绝。单实例插件聚焦已有窗口。
- 关闭窗口发送私有 shutdown，复用现有服务清理，15 秒后用 Windows Job Object 结束本次托管树。壳被强杀时 Job handle 关闭；管道 EOF 也请求服务退出。服务 ready 等待上限 45 秒，不等待 llama.cpp 下载。
- 默认数据目录由 Tauri `app_local_data_dir()` 获取，使用稳定 identifier `io.github.llama-web.desktop` 下的 `data`；可用绝对路径 `LLAMA_WEB_DATA` 覆盖。安装资源和用户数据分离；默认卸载保留数据。NSIS 自带的「删除应用数据」选项会删除默认 identifier 下的用户数据，保留数据时不要勾选。
- Bun 1.3.14 在 Windows 下直接执行禁止写入的 `.mjs` 报 `EPERM reading`（普通文件读取成功）。壳将 Nuxt 产物和导入助手以字节流复制到 `data/run/desktop/<摘要前24位>`，完整副本原子发布后启动；目录内保存完整摘要，防止短名碰撞认领错误副本。Bun 本身仍从安装资源启动。短缓存路径避免 sharp 的 Windows DLL 路径过长；自定义极深数据路径尚未验证。缓存跨启动保留，旧包缓存保留以便回退，导入不复制 `run`。未发布的 `.tmp-<UUID>` 在单实例壳下次启动时检查并清理。
- 新数据目录先显示「开始使用 / 从旧 data 目录复制」。目录由用户显式选择；源与目标都持有 5-1 的互斥锁，拒绝覆盖已有数据、目录嵌套和符号链接。先将允许的文件复制到 `import-backups/<id>`，再发布到目标；不复制 `run` 下的 PID 和锁。源码原有配置内容保持不变。
- 复制发布期间被硬杀会留下 `run/import.pending.json`；壳显示「从备份恢复」并阻止部分数据启动。v2 标记区分备份 / 发布阶段，完整备份带 SHA256 内容摘要；恢复前检查摘要、配置、链接与系统路径，保留部分目标数据到相邻的恢复备份，再重新发布。备份尚未完成且尚未发布时可返回首次选择页，残缺备份保留。v1 标记兼容恢复，但旧备份没有摘要。恢复再次中断仍可重试，标记只在完整发布后清除。GUI 按钮尚未人工验收。

## 本轮实测（2026-10-02）

- 标准 `bun test`：643 pass / 0 fail（43 文件，无 skip）；`bun run typecheck` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：3 pass。身份不匹配被拒、导航来源比较、Job 退出只结束自有进程。
- `cargo check --locked`、Tauri 调试构建、`bun run desktop:build` 成功；安装包约 34 MiB，包含 Bun、Nuxt、sharp、许可和版本清单。
- 调试壳 + 临时配置（自动下载关闭）：中文首次向导可见，实时连接指示正常；重复启动仅保留原壳与原 Bun；关闭主窗口后 Bun 退出、测试端口释放。
- NSIS `/S /D=<中文与空格测试目录>` 安装退出码 0；随后静默卸载退出码 0。启动了安装版测试进程，但用户按 Escape 停止电脑操作，未继续确认其页面。测试进程已停止。
- 内置 Bun 从打包产物导入 sharp，1200×800 图像缩放并编码为 200×133 JPEG 成功。

以上是首次会话的结果；本次接续结果见下节。

安装包 SHA256：`9de4421937a25aa7e6db442f0a047300f47d77ca7f0e147b8810fa985bfb17ee`。 <!-- pre-commit:allow: public installer checksum -->

清理：新打包脚本的临时工作树均已移除。首次失败构建的长路径临时目录仍有残留，工具自动审批拒绝了递归删除（只返回 `blocked by policy`）；本轮测试夹具与验证日志也保留在忽略的 `.cache/`。本地资源记录在忽略的 `.cache/desktop-5-2-resources.json`；接续时按记录核对所有权后处理，不清理用户其他目录。构建缓存与 `dist/desktop` 中的本地测试包保留。

## 接续验证（2026-10-02）

- `bun test`（命令 PATH 加入已安装 Git 的 bin）：652 pass / 0 fail（43 文件，无 skip）；`bun run typecheck` 通过。
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` 通过；`cargo test --manifest-path src-tauri/Cargo.toml --locked`：4 pass / 0 fail。新增缓存完整发布、异常复制后重试、残缺暂存清理测试。
- 导入共 11 项测试：实际强杀复制进程后恢复；恢复再次中断；备份被修改后拒绝恢复；旧标记兼容；未完成备份退回首次选择；源 / 目标锁释放；跨系统模型路径和 linked run / backup 拒绝。帮助程序只输出 i18n 错误码，不输出配置内容或 key。
- `bun run desktop:build`、后续 `bun x tauri build --bundles nsis` 通过。缓存最初复用过长摘要目录，导致 sharp `LoadLibrary` 报路径过长；缩短目录并保存完整身份后，最终包通过只读安装资源验证。
- 临时脚本 `bun .cache/desktop-verify-installed.ts`：最终安装包在中文空格目录安装；安装后四个页面 HTTP 200；PATH 无 Bun / Node / Rust / Git 时使用内置 Bun；动态 SSE 的 loading / ready / activity；假上游静默 12 秒仍完整流式；假模型切换 / 运行库回退；加载中强杀壳、死 owner 重启；前后两个 **同为 0.0.0** 的本地构建覆盖重装 / 回装、卸载保留构造的配置、key 和模型目录引用通过。不是不同正式版本号的升级 / 故障安装验收。
- 临时脚本 `bun .cache/desktop-verify-channel.ts`：占用端口的未知 HTTP 200 服务保持运行，本次服务退出且没有 private ready；释放端口后重启获得 private ready 并正常 private shutdown。没有点击启动页的重试按钮。
- 临时脚本 `bun .cache/desktop-verify-readonly-cpu.ts`：ACL 禁止写入安装资源，写探针被拒绝；最终短缓存包启动成功；官方 b11140 CPU 资产下载、摘要校验、解压，真实文本 GGUF、0 GPU 层和短流式完成通过。本机有 NVIDIA，不等于已在无 NVIDIA 机器验收；旧 CPU 的指令集下限尚未真机确认。脚本收尾 `rmSync` 报 EACCES，退出码 1；ACL 已恢复、测试安装已卸载、壳与 llama-server 已停止，目录残留见本地资源记录。
- 临时脚本 `bun .cache/desktop-verify-real.ts`：构造隔离配置，用现有两个文本 GGUF 和复制的运行库做 NVIDIA 加载 / 流式 / 切换；官方 b11140 CUDA 资产下载、摘要校验、解压，回退后真实重载和流式完成通过。真实 settings 仅用于只读定位模型目录，未作为夹具复用；未读取真实 secrets、未修改真实配置或模型文件。

**仍未运行 / 未完成：** WebView 可见页面、深浅色、窗口内长请求 / 动态 SSE；GUI 冲突提示与重试、导入选择 / 恢复按钮；正常关窗时真实加载 / 下载 / 解压中止；无开发工具 / 无 NVIDIA 的干净 Windows 环境；不同版本号升级 / 安装失败后的回退；极深自定义数据路径。没有恢复上轮 Escape 停止的窗口自动化；没有真实 Cloudflare、Release 或 Mac。5-2 两项继续未勾选，建议后续对导入恢复和运行缓存做独立复审。

新本地测试包：`dist/desktop/llama-web_0.0.0_x64-5-2-setup.exe`（未签名，约 34 MiB）。SHA256：`1f895182b3c8d2b1f4cabaf33ce1a3b31c7ab85ee2b7b456c0b80a2e21305278`。 <!-- pre-commit:allow: public installer checksum -->

清理：临时工作树已清除；正常测试脚本的自有进程 / 安装 / 数据已收回，测试改动的 NSIS 上次安装位置恢复。递归删除及逐文件删除均被自动审批拒绝，仅返回 `blocked by policy`；旧构建临时目录、首次安装脚本失败的夹具、CPU 验收收尾 EACCES 的目录，以及探针脚本 / 路径定位信息保留在忽略目录，不用其他方式绕过，不提交这些文件。位置、所有权及恢复状态在忽略的 `.cache/desktop-5-2-continuation-resources.json`，不在公开文档写机器路径。测试日志、该资源记录、构建缓存与两个本地包有意保留。
