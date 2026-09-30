# AGENTS.md

给在本仓库里工作的 AI 代理的说明。人类读者请看 `README.md` 和 `docs/plan.html`。

## 项目是什么

llama-web：本地私有 LLM 控制台。一个 Nuxt + Bun 进程，负责：

- 启动、停止、切换 `llama-server.exe`（自己管理子进程，不依赖 llama-swap）
- 提供 OpenAI 兼容 API（`/v1/*`），按请求里的 `model` 自动切换模型
- 请求预处理（目前只有图片压缩）
- 扫描模型目录、读取 GGUF 元数据
- 中文管理界面：总览 / 模型 / 日志 / 设置
- 可选的公网入口（Cloudflare 隧道 → `:8080`，只开放 `/v1/*`，校验 API key）
- 自动更新官方 llama.cpp Release，保留旧版本用于回退

**完整需求、决定和进度都在 [`docs/plan.html`](docs/plan.html)。开始任何工作前先读它。** 它是唯一的计划来源；本文件只写工作规则。

开发按「工作包」进行，一个工作包一个会话：

- [`docs/claude-guide.html`](docs/claude-guide.html)：每个工作包的范围、推荐模型、提示词，以及「会话规则」和「会话收尾流程」。**开始和结束会话都按它来。**
- [`docs/handoff.md`](docs/handoff.md)：会话之间的交接记录。开始时读最上面一条，结束时在最上面追加一条。

## 技术栈

- Nuxt 4（Nitro，`bun` preset）+ TypeScript
- Bun：运行时、包管理、测试（`bun test`）
- Nuxt UI（Tailwind）
- sharp（图片处理）
- 平台：Windows 11 + NVIDIA GPU（CUDA 版 llama.cpp）

## 常用命令

```bash
bun install          # 安装依赖
bun run dev          # 开发模式
bun test             # 单元测试
bun run build        # 构建
start.bat            # 用户实际使用的启动方式
```

（项目初始化后，如命令有变化，请同步更新这里。）

## 目录

- `app/`：前端页面、组件、composables
- `i18n/zh-CN.ts`：**所有界面文案**。组件里不要写死中文字符串
- `server/api/`：管理接口
- `server/routes/v1/`：OpenAI 兼容转发
- `server/core/`：scheduler、runner、args、scanner、gguf、preprocess、errors、updater、gpu、store、backends
- `server/plugins/`：启动时执行的逻辑
- `tests/`：单元测试
- `docs/plan.html`：开发计划与进度
- `data/`：运行数据（已加入 .gitignore，见下文）

## 硬性规则

### 敏感信息（公开仓库）

- `data/` 永远不能提交。不要修改 `.gitignore` 里关于 `data/` 的规则。
- 除非任务明确需要，不要读取 `data/secrets.json`；需要时也不要在输出里复述 key 的内容。
- 代码、测试、文档、提交信息里不能出现：个人路径（例如用户的模型目录）、域名、隧道名、API key、账号名。示例一律使用 `X:\models`、`example.com` 这类占位值。
- 测试夹具不能使用真实的配置文件；需要时自己构造假数据。

### 进程与端口

- 启动 llama-server 时必须传**参数数组**，不能拼接成字符串后交给 shell。
- `--host` / `--port` 由 llama-web 分配，用户配置不能覆盖。
- 子进程记录到 `data/run/pids.json`；停止时要结束整个进程树。清理残留时只结束可执行文件位于 `data/runtime/` 下的进程，不能误杀用户自己手动启动的 llama-server。
- 公网入口 `:8080` 只能绑定 `127.0.0.1`，只允许 `/v1/*`。修改鉴权或来源识别相关代码时必须补充测试。

### 行为约定

- 行为规则（状态机、排队切换、参数合并、路由、来源识别）以 `docs/plan.html` 的「核心行为规则」为准。要改规则，先问用户，再同时更新计划文档。
- 标记为「坑位」的功能只保留数据字段或接口，不要顺手实现。
- 界面风格：简洁、留白、分组卡片；跟随系统深浅色；深色模式用灰底，不用纯黑、纯白；只用一种强调色。

### 计划文档的维护

- 完成一项任务时，在 `docs/plan.html` 中把对应的 `<li class="task" data-done="false">` 改为 `data-done="true"`，并在 `<span class="when">` 里填写完成日期（YYYY-MM-DD）。
- 只有**实际完成并验证过**的任务才能打勾。部分完成的不打勾，在汇报里说明还差什么。
- 新发现的必要任务，加到对应阶段的任务列表里。
- 决定有变化时，修改「关键决定」表，并在「变更记录」里加一行。

### 阶段关口

- 开发分为 4 个阶段，每个阶段由几个工作包组成。**每个工作包结束时提交并推送**，然后按指南告诉用户下一个工作包。
- **每个阶段的最后一个工作包完成后停下来**，等用户试用和审查确认，得到确认后才开始下一阶段。
- 一个会话只做一个工作包；做不完就停在测试能通过的干净点，写好交接，让用户开新会话接续。
- 阶段结束时的真机冒烟会实际占用 GPU：开始之前先告诉用户。
- 汇报必须如实：列出实际运行的命令、结果、失败项；没有运行的验证要明确说明没有运行。

## 代码风格

- TypeScript strict；服务端核心逻辑写成不依赖 Nitro 的纯模块，方便 `bun test` 测试。
- 注释和标识符使用英文；面向用户的文案放在 i18n 文件里（中文）。
- 配置文件带 `version` 字段；修改结构时写迁移函数，不能直接让旧配置失效。
- 写配置文件必须原子写入（先写临时文件再改名），并保留备份。

## 提交

- 提交信息使用简短英文或中文均可，说明做了什么。
- 提交前运行 `bun test`；失败时不要提交，除非用户明确同意。
