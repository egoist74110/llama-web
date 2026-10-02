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
- 默认数据目录由 Tauri `app_local_data_dir()` 获取，使用稳定 identifier `io.github.llama-web.desktop` 下的 `data`；可用绝对路径 `LLAMA_WEB_DATA` 覆盖。安装资源和用户数据分离；安装 / 卸载代码不删除数据目录。
- 新数据目录先显示「开始使用 / 从旧 data 目录复制」。目录由用户显式选择；源与目标都持有 5-1 的互斥锁，拒绝覆盖已有数据、目录嵌套和符号链接。先将允许的文件复制到 `import-backups/<id>`，再发布到目标；不复制 `run` 下的 PID 和锁。源码原有配置内容保持不变。
- 复制发布期间被硬杀会留下 `run/import.pending.json`；壳拒绝用部分数据启动，完整备份留在相邻 `import-backups` 目录。自动恢复和可操作的恢复引导尚待接续完善；不能删除标记后盲目启动。

## 本轮实测（2026-10-02）

- 标准 `bun test`：643 pass / 0 fail（43 文件，无 skip）；`bun run typecheck` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：3 pass。身份不匹配被拒、导航来源比较、Job 退出只结束自有进程。
- `cargo check --locked`、Tauri 调试构建、`bun run desktop:build` 成功；安装包约 34 MiB，包含 Bun、Nuxt、sharp、许可和版本清单。
- 调试壳 + 临时配置（自动下载关闭）：中文首次向导可见，实时连接指示正常；重复启动仅保留原壳与原 Bun；关闭主窗口后 Bun 退出、测试端口释放。
- NSIS `/S /D=<中文与空格测试目录>` 安装退出码 0；随后静默卸载退出码 0。启动了安装版测试进程，但用户按 Escape 停止电脑操作，未继续确认其页面。测试进程已停止。
- 内置 Bun 从打包产物导入 sharp，1200×800 图像缩放并编码为 200×133 JPEG 成功。

**未运行 / 未完成：** 安装版页面与深浅色、WebView 长请求和动态 SSE；实际端口冲突提示 / 重试；真实模型加载、流式、切换、回退；无 NVIDIA / 无开发工具的干净环境；只读安装资源；加载 / 下载 / 解压中关闭及强杀壳后完整恢复；覆盖安装 / 回退保留配置和 key；数据导入 GUI、跨系统路径拒绝及导入中断恢复。没有占用 GPU，没有读取或改动真实配置 / secrets，没有访问真实 Cloudflare，没有 Release 或 Mac 构建。

安装包 SHA256：`9de4421937a25aa7e6db442f0a047300f47d77ca7f0e147b8810fa985bfb17ee`。 <!-- pre-commit:allow: public installer checksum -->

清理：新打包脚本的临时工作树均已移除。首次失败构建的长路径临时目录仍有残留，工具自动审批拒绝了递归删除（只返回 `blocked by policy`）；本轮测试夹具与验证日志也保留在忽略的 `.cache/`。本地资源记录在忽略的 `.cache/desktop-5-2-resources.json`；接续时按记录核对所有权后处理，不清理用户其他目录。构建缓存与 `dist/desktop` 中的本地测试包保留。
