# 首次启动上下文设置：独立审查交接

本文件记录实施和验证，独立审查尚未执行。

## 范围与已确认行为

- 起点：`25980a6`。提交后用 `git diff 25980a6..HEAD` 审查本工作包。
- 唯一实现项：阶段 8 用户反馈「首次启动上下文设置」，对应关键决定 46。
- 用户确认：始终保存本次值到当前方案；勾选时另同步 Windows GPU / CPU 两份全局默认。Mac 只有一份可用的全局默认。其他方案覆盖与额外参数保持原优先级。
- 首次框第一项显示完整数值，旁边按 1024 换算为 K，辅助值取四位有效数字；全局选项默认不选，重新打开重置。`0` 保持模型自带长度语义，留空保存为 null（不传参数）。
- 沿用现有有限数字校验，没有额外增加正数 / 整数 / 训练上限政策；实际启动合法性仍由 llama-server 判断。
- 保留 `useModelStartFeedback` / `useLive` 的失败反馈链路。未改调度器、启动器、参数合并器、配置版本、依赖或其他反馈项。

## 修改文件与调用链

1. `app/components/FirstStartDialog.vue`：从首次 GET 读取上下文，新增第一项、K 显示和全局选项；POST 携带 `ctxSize` / `setGlobalContext`。既有 begin / accepted / httpFailure 跟踪保持。
2. `server/api/models/[id]/setup.get.ts`：复用 `previewLaunch`，通过当前方案与模型的运行库选择、`defaultsFor` 和参数合并返回 `current.ctxSize`。这里是表单合并值，额外参数中的上下文仍优先且有文案提示；不启动任何运行库程序。
3. `server/api/models/[id]/setup.post.ts` → `server/core/first-setup.ts::saveFirstSetup` → `models-admin.ts::applyFirstSetup`：先在克隆文档上校验全部答案；只改当前方案的上下文字段，保持其其他覆盖、文件确认与原 MTP / 思考处理。
4. 勾选时用现有 `writePair`：`updateSettings` 更新上下文 → `updateModels` 保存首次答案；后一步失败就只恢复全局上下文字段。每步复用 `JsonStore.update` 的磁盘刷新、克隆、备份和原子写入；整个写入段同步执行，其他 HTTP 请求不会在中间插入。
5. 保存全部成功后，原 POST 流程才通过 `background` → `ctx.ops.start` → `planLaunch` → `buildLaunchArgs` 启动。后续 `ModelEditor` / `saveProfile` 读取同一方案字段，可自定义或切回继承；无需另一套编辑逻辑。
6. `i18n/zh-CN.ts`：新增上下文、全局范围说明与无效上下文错误。`tests/core/first-setup-context.test.ts`：真实 JsonStore 隔离文件保存 / 回退，启动参数及后续编辑行为回归。

## 数据与访问边界检查

- 管理接口沿用本机 / 局域网访问模型，无账户角色；现有 `admin-origin` 中间件仍拒绝跨站 JSON 写入，公网入口仍仅放行 `/v1/*`。没有扩大权限或更改鉴权。
- 上下文只接受有限 number / null，新增全局选项必须是 boolean。缺省上下文保持旧客户端行为；勾选全局却未提供上下文拒绝保存。拒绝的输入不回显，不读取或记录 secrets。
- 配置写入前验证文件选择与 MTP 倍数，避免它们失败后留下全局变更。全局写失败不写模型；模型写失败恢复全局；回退再次失败以 AggregateError 报告两次错误，不返回成功、不启动。
- LiveHub 通过延迟合并通知发布最终状态；未新增订阅、计时器、子进程或后台任务。
- 延续现有两文件保存能力：单文件原子写入，失败时尽力回退；不是断电 / 强制终止下的跨文件事务。若在两次写入之间进程突然退出，可能仅保存全局值，模型仍未确认；下一次首次确认可重新保存。未实现崩溃恢复日志或额外后台任务。

## 验证记录

- `bun test tests/core/first-setup.test.ts tests/core/first-setup-context.test.ts`：最初 26 pass / 2 fail；两项测试分别误返回 Profile 给 JsonStore、误认为被覆盖的旧上下文参数仍保留。修正测试后 28 pass / 0 fail；随后加非默认当前方案用例，新的上下文专项为 22 pass / 0 fail。
- `bun test tests/core/first-setup.test.ts tests/core/first-setup-context.test.ts tests/app/model-start-feedback.test.ts tests/app/model-start-notice.test.ts`：43 pass / 0 fail（添加最后一项上下文用例前）。
- 最终 `bun test`：1000 pass / 51 skip / 0 fail，1051 项、72 文件、51.27s；`bun run typecheck`、`bun run build`、`git diff --check` 通过。一次重建失败：测试服务占用 sharp DLL 导致 EPERM；停止自己的服务后重建通过。
- 隔离生产构建浏览器实测：第一项及完整值 / K；4096 本地保存、12288 全局保存并在 GPU / CPU 两页显示；6144 后续自定义与切回继承 12288 的命令预览；取消 / Esc 不保存、重开重置；留空、0K / 0 保存、极小值 K 不误显 0；Tab / 空格切换；默认浅色与 375px 深色；首次确认关闭后仍弹 no-runtime 提示。
- HTTP 实测：四种无效上下文输入返回 400，跨站写入返回 403，两份磁盘文件逐字保持；浏览器保存的本地 / 全局 / 继承 / 0 与未确认状态均用隔离文件断言。
- 未运行：真实模型加载 / GPU 推理、真实运行库下载、Windows 桌面安装包重打 / 安装、Mac 真机。Mac 单份默认仅由构造数据验证。没有读取用户实际配置或 secrets。
- 测试服务及浏览器标签页已停止 / 关闭，5301 端口释放，视口与主题已恢复。删除临时目录被自动审批拒绝（`blocked by policy`），夹具 / 脚本 / 日志留在忽略的 `.data/first-context-smoke-20261004-b47a/`，不提交且未换方式删除。两张审查截图保留在会话产物。

## 下一轮独立审查提示词

```text
独立审查阶段 8 用户反馈工作包「首次启动上下文设置」。
先遵循 AGENTS.md，读取 router，再读 docs/plan.html 关键决定 46、docs/handoff.md 最新交接和 docs/reviews/first-start-context.md。
审查 git diff 25980a6..HEAD。只审查，不修改代码。
重点核对首次 GET 的运行库 / 全局默认选择、完整值与 K 显示、首次 POST 写入当前方案与两份全局默认、非法输入 / 写入失败 / 回退失败、旧客户端兼容、启动参数与额外参数优先级、后续编辑和继承，以及刚完成的启动失败提示是否保留。
每个发现给严重程度、文件行号、具体触发条件和影响，区分确定问题与未验证风险。按需要运行测试并如实记录；不下载运行库，不占 GPU，不实现 MTP、思考上限或其他反馈。
```
