# 交接记录

每个会话结束时在**最上面**追加一条，30 行以内。新会话只需要读最上面一条。
不要写入个人路径、域名、key。

格式：

```
## YYYY-MM-DD · 工作包 X-X · 模型
- 完成：…（对应 plan 的哪几项）
- 验证：实际运行的命令和结论
- 剩余：没做完的部分（没有就写「无」）
- 决定 / 坑：实现中做的、后面的会话需要知道的决定和踩到的坑
- 下一步：下一个工作包编号
```

---

## 2026-09-30 · 工作包 1-2 · Sonnet 5.5
- 完成：plan 阶段 1 第 3–6 项。`server/core/` 下 store.ts、gguf.ts、scanner.ts、args.ts、types.ts（FileRef / ModelDir）；测试在 `tests/core/`，假 GGUF 构造器 `tests/fixtures/gguf-builder.ts`。
- 验证：`bun test` 52 通过（连跑 3 次）；`bun run typecheck` 通过（只覆盖 `server/` 和 `app/`，不含 `tests/`）。全部用自造的假文件和临时目录，没碰真实模型或配置。
- 剩余：无。「单元测试」那一项没打勾：scheduler 和路由解析还没写。
- 决定 / 坑：
  - store：`JsonStore<T>`（load / get / save / update / watch / close）。缺文件写默认值；JSON 损坏、无 version、版本更新时抛 `StoreError`，不覆盖原文件；`watch` 遇到坏文件保留旧值并回调 onError，自己写的不触发回调。每次覆盖前备份到 `backups/`（默认留 20 个）。迁移函数 `migrations[n]` 是 n→n+1。
  - gguf：`readGgufMeta(path)` 只读头部和 tensor 信息，大数组直接跳过。参数量优先 `general.parameter_count`，没有就累加 tensor（分片时只是本片的）。
  - scanner：`scanModelDirs(dirs)` 返回 `entries`（kind = model/mmproj/draft/invalid，分片合并，`candidates` 只列同目录文件）和 `warnings`。mmproj 看架构 `clip` / `general.type` / 文件名；draft 看文件名或架构含 mtp / draft。`resolveFileRef` 拒绝 `..` 越界。`maxDepth` 0 = 只扫根目录。跳过 `.` 和 `$` 开头的目录。
  - args：`buildLaunchArgs` 返回参数数组（不含 exe）、warnings（只有 code / flag / layer，中文文案放 i18n）、ok。表单项用长参数名；`undefined` = 继承，`null` 或 `''` = 自定义为不传。额外参数三层（全局 → 模型 → 方案）依次拼接，后出现的同名参数替换前面的（不警告），同一段里重复才警告；`--host` / `--port` 会被剔除。额外参数在表单参数之后，host / port 永远在最后。
  - **和计划文档有出入，待用户确认**：计划里 `--jinja` 被当作「表单已管理」的例子，但设置结构里没有对应字段，所以 `--jinja` 目前不会触发重复警告。
  - 给 `tests/platform/process-tree.test.ts` 的两个用例加了 30 秒超时：这台机器上启动 bun 子进程要 2.5–5 秒，全量跑时会超过默认 5 秒。逻辑没改。
  - 没新增依赖，参数拆分是自己写的（string-argv 不需要了）。
- 下一步：工作包 1-3（Opus 5.5）。

## 2026-09-30 · 工作包 1-1 · Opus 5.5
- 完成：plan 阶段 1 第 1–2 项。Nuxt 4.5 + Bun 1.3 + TS 脚手架（nitro preset bun、strict、i18n/zh-CN.ts、最小首页）；技术验证三项；AGENTS.md 常用命令。
- 验证：`bun test` 6 通过（tests/platform/sharp、process-tree）；`bun run typecheck` 通过；`bun run build` 通过；`bun run dev` 首页 200。SSE/入口用临时路由 + 构建产物实测，临时文件已删除。
- 剩余：无。真实 llama-server 的启动 / 杀树没测（还没有二进制），按指南在 1-3 测；关 start.bat 窗口的场景在 1-6 测。
- 决定 / 坑：
  - 新增关键决定 25：Nitro 自带 bun 入口拿不到 req.signal 和客户端 IP、Bun.serve 默认空闲超时 10 秒会断开静默请求。改用自定义 Bun 入口（`nitro.entry`，必须绝对路径，`~~` 别名不解析）：`server.timeout(req, 0)`；/v1、/upstream 走 Bun 原生；其余走 `nitroApp.localFetch`，入口覆盖写入内部请求 ID 头，处理函数据此从共享 Map 取 signal / IP。以上都已实测可行，细节见 plan「风险与待验证」。
  - `nuxt dev` 不走自定义入口，1-4 要考虑开发模式下 /v1 怎么跑（或约定只用构建产物测转发）。
  - 自带入口会先把整个请求体读进内存；请求体上限要在自定义入口里做。
  - Bun 子进程会随 Bun 父进程一起退出（即使 taskkill /F 父进程），残留风险比预期小，但 pids.json 清理仍要做。主动停止用 `taskkill /PID <pid> /T /F`。
  - 读进程 exe 路径：PowerShell `Get-CimInstance Win32_Process`，耗时数秒，只在启动清理时用。
  - typescript 固定 5.x（vue-tsc 不支持 TS 7）。
- 下一步：工作包 1-2（Sonnet 5.5）。

## 2026-09-30 · 规划 · Opus 5.5
- 完成：需求问答（24 轮），写出 docs/plan.html、docs/claude-guide.html、AGENTS.md；建立公开仓库。
- 验证：无代码。
- 剩余：无。
- 决定 / 坑：所有决定见 plan.html「关键决定」。开发按工作包进行，一个工作包一个会话。
- 下一步：工作包 1-1（Opus 5.5）。
