# Windows desktop

5-2 本地测试包已由用户试用确认（未在干净机 / 无 NVIDIA 上试用）。5-3 起由 GitHub Actions 生成草稿 Release，结果见文末「5-3」。Mac 未开始。

## 构建

需要原生 Windows x64、Bun 1.3.14、Rust 1.99.0 MSVC、Visual Studio C++ Build Tools / Windows SDK、Git。Rust 和 Cargo 需在 PATH 上。WebView2 是应用运行要求，NSIS 使用 downloadBootstrapper 检查 / 安装；缺少时需要联网。当前测试包未签名，版本 0.0.0 仅供本地验证，不是 Release 版本。

```powershell
bun install --frozen-lockfile
bun run desktop:build
```

`desktop/prepare.ts` 在独立工作树构建 Nuxt，复制完整 `.output`、固定 Bun、数据导入助手和许可到生成目录 `src-tauri/resources/`。不读取 `data/`、`.env` 或真实 secrets，不改主目录 `.output`。安装包位于 `src-tauri/target/release/bundle/nsis/`。

## 生命周期和数据

- Rust 通过参数数组启动绝对路径的内置 Bun，并隐藏控制台。主服务仍读取既有 host / port；不自动换端口。监听失败时服务经私有管道只报告固定原因码（`portInUse` / `listenFailed`）和端口，启动页据此显示中文原因，不显示错误原文。
- ready / shutdown 仅使用继承的 stdin / stdout 管道，消息携带本次 UUID、协议版本和子进程 PID。HTTP 没有退出接口；现有页面没有 Tauri 原生权限。启动页独享状态、重试、退出和显式目录导入权限。
- 主窗口仅允许本次 `http://127.0.0.1:<port>` 来源；HTTP / HTTPS 外链交系统浏览器，其余导航拒绝。单实例插件聚焦已有窗口。
- 关闭窗口发送私有 shutdown，复用现有服务清理，15 秒后用 Windows Job Object 结束本次托管树。壳被强杀时 Job handle 关闭；管道 EOF 也请求服务退出。服务 ready 等待上限 45 秒，不等待 llama.cpp 下载。
- 默认数据目录由 Tauri `app_local_data_dir()` 获取，使用稳定 identifier `io.github.llama-web.desktop` 下的 `data`；可用绝对路径 `LLAMA_WEB_DATA` 覆盖。安装资源和用户数据分离；默认卸载保留数据。NSIS 自带的「删除应用数据」选项会删除默认 identifier 下的用户数据，保留数据时不要勾选。
- Bun 1.3.14 在 Windows 下直接执行禁止写入的 `.mjs` 报 `EPERM reading`（普通文件读取成功）。壳将 Nuxt 产物和导入助手以字节流复制到运行缓存 `<应用本地数据目录>\rc\<摘要前24位>`（即 `app_local_data_dir()` 下的 `rc`，与 `LLAMA_WEB_DATA` 无关），完整副本原子发布后启动；目录内保存完整摘要，防止短名碰撞认领错误副本。Bun 本身仍从安装资源启动。0.0.0 包把缓存放在 `data/run/desktop`，自定义数据目录很深（约 200 字符）时 sharp 的 DLL 超过 Windows `LoadLibrary` 的路径上限，服务无法启动；0.0.1 起改为上述固定短目录。缓存跨启动保留，旧包缓存保留以便回退（旧包仍用 `data/run/desktop`），导入不复制 `run`。未发布的 `.tmp-<UUID>` 在单实例壳下次启动时检查并清理。
- 新数据目录先显示「开始使用 / 从旧 data 目录复制」。目录由用户显式选择；源与目标都持有 5-1 的互斥锁，拒绝覆盖已有数据、目录嵌套和符号链接。先将允许的文件复制到 `import-backups/<id>`，再发布到目标；不复制 `run` 下的 PID 和锁。源码原有配置内容保持不变。
- 复制发布期间被硬杀会留下 `run/import.pending.json`；壳显示「从备份恢复」并阻止部分数据启动。v2 标记区分备份 / 发布阶段，完整备份带 SHA256 内容摘要；恢复前检查摘要、配置、链接与系统路径，保留部分目标数据到相邻的恢复备份，再重新发布。备份尚未完成且尚未发布时可返回首次选择页，残缺备份保留。v1 标记兼容恢复，但旧备份没有摘要。恢复再次中断仍可重试，标记只在完整发布后清除。选择目录和「从备份恢复」按钮已在安装版窗口中验证（见第三次接续）。

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

## 第三次接续：窗口 / GUI / 中断与升级验收（2026-10-02）

方法：安装包装到忽略目录（中文与空格路径），用构造的数据目录（假 llama-server、假 GGUF、构造 key）或只读引用本机模型文件。只给测试壳设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`，通过 CDP 读取 / 截图 / 点击两个 WebView；关窗用 `WM_CLOSE`（与标题栏关闭相同）；文件夹对话框用窗口消息填路径并按「选择文件夹」。没有接管鼠标键盘。临时脚本在忽略的 `.cache/gui-*.ts`，截图在 `.cache/gui-shots/`。

本轮修复（均有测试）：

- 端口被占用时启动页原来只显示 `Service exited (exit code: 1).`，没有原因。服务监听失败时经私有管道发送固定原因码和端口，壳校验本次身份后显示「端口 N 已被其他程序占用……不会结束它，也不会自动换端口」。Bun 测试 + Rust 测试覆盖身份不符 / 未知原因码被忽略。
- 自定义数据目录约 200 字符时服务无法启动：sharp DLL 路径超限（`LoadLibrary failed: 文件名或扩展名太长`）。运行缓存移到应用本地数据目录下的固定短目录 `rc`。
- 首次下载 llama.cpp 失败时总览补充「检查网络后重新打开 llama-web 会再次下载」（更新检查只在打开时进行，属既有设计）。
- 测试包版本改为 0.0.1（`versions.json` 读取 Tauri 版本），用于与 0.0.0 包做真实跨版本升级 / 回装；仍是未签名本地测试包，不是 Release。

实测结果（最终包 `llama-web_0.0.1_x64-5-2-setup.exe`；第 2–4 项在只差上述提示文案的前一个 0.0.1 构建上运行，第 1、5 项在最终包上重跑）：

1. 窗口：总览 / 模型 / 日志 / 设置在 WebView2 中均有中文内容；浅色 / 深色随 `prefers-color-scheme` 切换，深色背景 `rgb(27, 29, 33)`，无横向溢出（截图已目视检查）。窗口内 SSE：点启动后页面不刷新即显示「加载中」→「运行中」。窗口内 `fetch` 流式：首块约 12 ms，上游静默 12 秒后完整收到 `[DONE]`。HTTP 页面里调用 `desktop_*` 与 `plugin:app / path / event / window / webview` 命令全部被 ACL 拒绝；把页面导航到其他来源被拒绝。端口被未知 HTTP 200 服务占用：显示原因，未知服务保持运行；仍占用时重试回到错误，释放后重试打开主窗口；「退出」按钮退出。正常关窗后 Bun 和 llama-server 结束、端口释放。
2. 首次运行：「从旧 data 目录复制」→ 系统文件夹对话框 → 选择构造的旧目录，配置 / 模型 / key 字节一致，旧目录不变，相邻 `import-backups` 保留、标记清除，随后自动启动。发布阶段被中断后显示「上次数据复制未完成」与「从备份恢复」（复制按钮隐藏），点击后恢复并启动。209 字符的数据目录可启动，2400×1600 图片经 sharp 缩到最长边 896（请求记录 `compressed: 1`）。
3. 正常关窗中止：官方 b11146 CUDA 下载中关窗 0.7 秒退出、解压进行中 2.3 秒退出，运行库目录无残缺版本；重开后重新下载并就绪。真实 27B GGUF 在 RTX 5090 加载中关窗 1.7 秒退出，显存回到基线（7087 → 6990 MiB）；重开后真实加载、流式回复，带已加载模型关窗 2.4 秒退出。
4. 升级 / 回退：0.0.0 安装 → 原位升级 0.0.1（注册表与 `versions.json` 均为 0.0.1）→ 安装进行约 0.9 秒时强制结束安装程序 → 原位重装 0.0.0 成功并可运行 → 再升级 0.0.1 → 卸载。每一步配置 / key / 模型目录引用字节不变，卸载后程序文件删除、数据保留。中断安装时具体写到哪些文件未逐一核对（主程序与 Bun 仍在）。
5. 断网（只对测试壳设置不可达代理，未改系统）：已有运行库时显示「检查更新失败（network），继续使用 b10001」，模型可加载应答；首次运行无运行库时四个页面可用，总览显示获取失败与重新打开提示，请求返回明确的「没有可用的 llama.cpp」。

其他：标准 `bun test` 653 pass / 0 fail，`bun run typecheck` 通过，Rust 5 pass，`cargo fmt --check` 通过。第一部分有一次运行在无输出的情况下超时（管道缓冲导致看不到卡在哪一步），清理其测试安装后重跑通过，原因未查明。导航拒绝测试使用 `http://example.invalid/`，壳按设计会把它交给系统浏览器，可能在本机浏览器打开过无法访问的页面；系统浏览器是否被调起未观察。

**仍未验证（需要另一台机器或用户试用）：** 无 Bun / Node / Rust / Git 的干净 Windows（本机只在 PATH 去掉开发工具后验证）；缺少 WebView2 时 bootstrapper 安装；无 NVIDIA 环境的 CPU 路径（本机显式 CPU 已在上一轮验证）及旧 CPU 指令集下限；本机没有 Windows Sandbox，启用它属于系统设置，需要用户自行决定。没有真实 Cloudflare、Release 或 Mac。

最终本地测试包：`dist/desktop/llama-web_0.0.1_x64-5-2-setup.exe`（未签名，约 34 MiB）。SHA256：`7b6ad14c54d32cede1a9726254707f4b721af1312d8986ca739df2b99cb3d728`。 <!-- pre-commit:allow: public installer checksum -->

清理：上两轮记录的残留目录（旧构建临时目录、首次失败夹具、CPU 验收 EACCES 目录等）本轮已核对归属后删除；本轮测试安装均已卸载，测试数据目录删除，测试在应用本地数据目录生成的 WebView 数据和运行缓存已删除，无遗留进程。`.cache/` 中的验收脚本、截图和日志及 `dist/desktop` 中的三个本地包有意保留。

## 5-3：首个 Windows Release 与应用内更新（2026-10-02 ~ 10-03）

- 用户确认：版本 `0.1.0-beta.1`（只写在 `package.json`，tauri.conf 引用它），MIT，未签名。
- 流程：`.github/workflows/release-windows.yml` 手动触发 → Windows runner 冻结安装、`bun test`、typecheck、`desktop:build`（`LLAMA_WEB_RELEASE=1`）、`cargo test`（必须在构建之后：tauri-build 需要生成的 resources）→ `desktop/check-package.ts` 检查 resources 与 7-Zip 解开的安装包 → SHA256SUMS、构建清单、许可 → `gh release create --draft --prerelease`。发布前不建 tag。
- 应用更新：服务按 `server/core/app-update.ts` 检查 GitHub Releases；桌面版下载到 `data/run/app-update`，GitHub 资产摘要与 SHA256SUMS 都要一致；服务经私有管道发 `install`，壳在服务退出后复核文件位置、文件名和 SHA-256（BCrypt），以 `/P /R /UPDATE` 启动安装程序后退出，装完由安装程序重开。`LLAMA_WEB_UPDATE_FEED` 只接受回环地址，仅供本机验收。
- 坑：NSIS `displayLanguageSelector: true` 时，被动安装也会弹「Installer Language」并卡住升级，已关闭（按系统语言自动选择）。CI 上 5-1 的进程身份测试一次因冷启动 PowerShell 超过 5 秒失败，重跑通过（产品逻辑在超时时保守地不记录身份）。
- 验收（从草稿下载的安装包，SHA256 与草稿 SHA256SUMS、GitHub 资产摘要一致）：包内 326 个文件 allowlist / 拒绝项 / 本机路径检查通过；中文空格目录静默安装、版本清单 0.1.0-beta.1 / unsigned / MIT、四页面、`/v1` 假模型应答、真实 GitHub 检查为「已是最新」（草稿不可见）、关窗后托管树结束且端口释放、卸载保留数据。应用内升级：假更新源提供本机构建的 0.1.0-beta.2 测试包（未发布）→ 自动检查后提示条与更新说明对话框、跳过 / 恢复提示、下载校验、确认对话框 → 旧壳 0.6 秒退出、被动安装、注册表与安装资源变为 0.1.0-beta.2、自动重开 → 同一数据目录字节不变、模型可应答、不再提示更新。
- 未验证：真实发布后从 GitHub 下载的升级（需要两个已发布版本）；干净 Windows / 无 NVIDIA / 缺 WebView2；源码版提示只做了单元测试和类型检查，未在浏览器中点击；SmartScreen 实际提示（本机下载不带网络标记时不出现）。
