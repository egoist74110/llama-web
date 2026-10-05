# 交接记录

## 2026-10-05 · 发布 v0.1.0-beta.6 + 一次「打不开」的排查 · Claude
- 发布：v0.1.0-beta.6（提交 e94b239）由 Windows 草稿工作流构建成功（工作流内 bun test / typecheck / cargo test / 包内容检查通过），下载的安装包 SHA-256 与 SHA256SUMS 一致（6190b2d2…edc9）、清单 commit 正确后发布为预发布版。内容见 `docs/release-notes/v0.1.0-beta.6.md`（首次按本机调参、重新推荐、模型删除、镜像兜底与自定义镜像、引导页、Cloudflare 权限修复等）。
- 用户反馈「打不开」（窗口：Service exited (exit code: 1) + Bun 版本号）。排查结论：用户机器上装的是 **beta.4**（resources/versions.json 为 0.1.0-beta.4），beta.6 并未装上；数据目录的 settings.json 已被用户之前用 start.bat 从源码运行时升到版本 8，而 beta.4 只支持到 7。装上 beta.6 后用户确认能正常打开。所以不是 beta.6 的问题。
- 未证实的部分：beta.4 具体在哪一步因配置更新而退出。当前代码读到更新版本的 settings 只记「使用默认值」并照常启动（用版本号 99 的配置实测过），所以「启动时读到新版配置就崩」不成立；更可能是启动后某次写配置被 `newer-version` 拒绝，未在 beta.4 上复现。
- 已撤回：曾做过一个「桌面壳识别新版配置并给中文提示」的改动（entry.ts / desktop-channel / main.rs / i18n），因为对应的启动失败路径实际不存在，没有提交，已还原。若以后要做类似提示，先在对应旧版上复现真实失败点。
- 排查中的教训：让用户手动跑服务时不能取 `rc` 下第一个目录，要按安装包 resourceId 前 24 位取对应缓存目录（beta.6 是 437ecd7a06c54fa1183c17d9）；窗口里只留了服务 stderr 的最后一行（Bun 版本号），真实报错在它上面，桌面壳不保存完整 stderr。
- 没验证：beta.6 安装包的完整安装与 beta.5 → beta.6 应用内更新、Windows 上的首次调参数值与回收站删除、大陆网络下镜像、真实模型 / GPU 推理。macOS CI 仍未通过，无 Mac 安装包。
- 下一步：用户用 beta.6 继续试用；阶段 8 其余项（MTP 真机验收、镜像清单复查等）不变。

## 2026-10-05 · 镜像后续：用户自填镜像（关键决定 53 未做部分） · Claude
- 用户确认三点：设置页一个「自定义镜像前缀」文本框，留空只用内置镜像，填了就在弹窗多出第三个选项；只接受 https，域名与重定向限制不变；新增 settings 字段并升版本、写迁移。
- 实现：`settings.mirror.custom`（版本 9，迁移 8 补空值；手改成非法值加载时被丢弃）；`mirrors.ts` 新增 `normalizeCustomMirror`（https、公网 DNS 名，拒绝 IP / localhost / 单段与 .local 等内网名 / 端口 / 账号密码 / query / fragment，补尾部 `/`）、`customMirror`，`mirrorById(id, custom)` 的 id `custom` 由服务端取已保存前缀（浏览器不传 URL）；`mirrorFetch` 与重定向规则未改。Updater / AppUpdater 经 `customMirror()` 读设置；设置页 `SettingsMirror.vue`，保存走 `applySettingsPatch` 的 `mirror` 段（非法 400，原子写 + 备份）；弹窗打开时重新读设置。文案在 i18n `mirror`。
- 系统代理：没做（要按平台读系统设置，非零成本）；测速自动选镜像：没做。
- 验证：新增 `tests/core/custom-mirror.test.ts` 5 项（校验与非法地址、留空行为不变、id 解析、域名 / 重定向限制、保存与迁移）通过；`bun run typecheck` 通过；全量 `bun test` 1066 pass / 19 skip / 63 fail，失败项与改动前（git stash 后 64 个）逐项对比：无新增，仅少一个偶发的 TunnelManager。
- 未运行：设置页与弹窗的浏览器走查（只过了类型检查与单测）；自填镜像的真实网络可用性；经镜像下载 llama-web 安装包；Windows；镜像清单复查。
- 下一步：用户试用；阶段 8 其余项（MTP 真机验收、镜像清单复查等）不变。

## 2026-10-05 · 已有安装「按本机重新推荐」默认参数（关键决定 54 未做部分） · Claude
- 用户确认三点：只重算全局默认（Windows GPU + CPU 两份，Mac 一份），模型 / 方案覆盖值不动；旧额外参数 `--jinja --props --slots -cb` 在预览里作为可勾选项（只去掉这四个，其他参数保留）；设置页按钮 + 差异弹窗 + 逐项勾选，确认才写入，取消不改。
- 实现：`server/core/retune.ts`（纯模块，`planRetune` 只读、`applyRetune` 重新计算后只改勾选且仍在方案内的项；复用 `tunedDefaults`，没有第二套分档）；`GET /api/settings/retune`（重新检测硬件后预览）、`POST /api/settings/retune {ids}`（经 `updateSettings` 原子写 + 备份；非法 ids 400）；`SettingsRetuneModal.vue`，按钮在 `SettingsDefaults.vue`（有未保存修改时禁用，避免被覆盖）；文案 `settings.defaults.retune`。无新配置字段，无迁移；应用后把 `setup.tuned` 置 true。
- 验证：新增 `tests/core/retune.test.ts` 9 项通过（分档边界、预览不写入、只改勾选项、空 / 未知 id 不改、Mac 只有一份、旧额外参数）；`bun run typecheck` 通过；全量 `bun test` 1060 pass / 64 fail，失败项与改动前（git stash 后）逐项一致（51 个 pre-commit 脚本等本机 Mac 原有，另含偶发 TunnelManager / registry / runner 端口等）。隔离数据目录 + `nuxt dev` 调接口：预览列出 4 项，只提交额外参数 id 时仅该项被写入（ctxSize 不变），settings 有备份，ids 非数组返回 400。
- 未运行：弹窗界面的浏览器走查（只验证了接口与类型）；Windows 实机（GPU / CPU 两份、真实显存检测）；真实模型加载；分档数值仍是保守经验值。
- 下一步：用户试用按钮；阶段 8 其余项（MTP 真机验收、镜像后续）与 Windows 试用关口不变。

## 2026-10-05 · A2 首次启动配置进入全局与单模型配置（关键决定 50） · Claude
- 核对结果：单模型侧上下文 / 思考 / 上限 / mmproj / MTP 早已有共享控件；缺口在全局页（思考上限只有原始数字框，无 MTP）。用户确认：全局思考上限改快捷控件；MTP 不进全局；首次确认的「设为全局」加思考开关、上限两个勾选；常用项抽出置顶、其余折叠。
- 服务端：`FirstSetup` 增加 `setGlobalThinking` / `setGlobalThinkingLimit`；`saveFirstSetup` 泛化为 ctxSize / reasoning / reasoningBudget 多字段同步（GPU + CPU，Mac 一份），先校验后写，模型写失败只回退改过的全局字段。无新配置字段、无迁移。
- 界面：`useParamFields` 新增 COMMON / MORE；`ProfileForm` 顶部「常用设置」（上下文、思考 + 上限、MTP）→ 聊天模板 / 运行库 / 设备 → 折叠「更多参数」→ CPU 进阶；`SettingsDefaults` 同样分组，思考上限用 `ThinkingLimit`（0 → -1），无效值阻止保存；`FirstStartDialog` 加两个勾选。文案在 i18n。
- 验证：新增 `first-setup-global.test.ts` 6 项、`param-groups.test.ts` 2 项；`bun run typecheck` 通过；全量 1050 pass / 19 skip / 65 fail，其中 62 个是改动前就有的 Mac 失败，另 3 个（TunnelManager、registry、runner 端口）偶发，重跑通过，与本改动无关。隔离数据目录 + `nuxt dev` + 浏览器：首次确认框勾选后 settings.json / models.json 值正确（Mac 只写一份）；全局页思考上限显示 512，改 0 保存得 -1，「更多参数」默认折叠；编辑抽屉参数页分组与折叠正常。
- 没验证：Windows 上 GPU + CPU 两份同步的真实界面（单测覆盖了 win32 两份）；窄屏 / 深色走查；真实模型启动。
- 提示：全局页「更多参数」默认折叠（全局本来每项都有值，无法按「有自定义」自动展开）；模型页折叠状态按有无自定义值决定。
- 下一步：阶段 8 剩余项见 plan（MTP 真机验收、旧安装是否「按本机重新推荐」、镜像后续）与用户在 Windows 上的试用关口。

## 2026-10-05 · 模型删除按钮 + 二次确认（关键决定 51） · Claude
- 用户确认三点：文件进系统回收站；共享的草稿 / 视觉文件跳过并提示（本模型自己的照删）；运行中 / 加载中 / 排队中拒绝删除，不自动停止。
- 实现：`server/core/model-remove.ts`（planRemove / removeModel，纯模块，可注入 trash 与文件系统）、`trash.ts`（Windows PowerShell + VB 回收站，路径走环境变量，失败按序号回报；Mac 用 osascript 让 Finder 删，路径作 argv；其他平台 gio；失败即报失败，绝不永久删除）、`ModelOps.busy / forget`（忙则抛 ModelBusyError，否则清理 failed / stopped 残留）。接口 `GET /api/models/:id/remove-plan`（弹窗预览）、`POST /api/models/:id/remove {deleteFiles}`。界面 `ModelRemoveModal.vue`，卡片和编辑抽屉各一个按钮；文案在 i18n `models.remove`。
- 规则：只处理已登记目录内、解析符号链接后仍在根内的 .gguf 常规文件；任一路径越界则整个「删文件」请求被拒（仍可只删配置），没有部分删除。分片按「前缀 + 总数」找全；同目录别的分片组不动。主模型文件移不进回收站 → 配置保留并报错；mmproj / 草稿失败只提示。配置沿用 modelsRef.update（原子写 + 备份）。
- 验证：`bun test tests/core/model-remove.test.ts` 17 pass（运行中、共享、分片、越界 / 符号链接、不勾选只删配置、主文件失败、已不存在、trash 参数）；`bun run typecheck` 通过；全量 `bun test` 1044 pass / 19 skip / 63 fail，失败项数与改动前一致（本机 Mac 原有，无一涉及本改动）。Mac 上用真实 osascript 把临时中文文件名 .gguf 移进废纸篓成功，不存在的路径报失败。
- 没验证：Windows 回收站路径（PowerShell 脚本未在 Windows 跑）；Windows 对超过回收站容量的大文件会弹系统确认框（选 AllDialogs 避免静默永久删除，隐藏进程下框能否点到未知，超时 10 分钟后该文件报失败）；浏览器里点按钮的界面走查未做（只过了 typecheck）；真实模型 / GPU。
- 已知边界：检查忙碌与移回收站之间有几秒窗口，期间若有请求触发加载不会被拦（Windows 上占用中的文件会移失败）；不删除变空的目录。
- 提示：Mac 探测用的临时文件已进废纸篓（~/.Trash 本会话无权限查看 / 清理，是个几字节的 lw-trash-probe 文件）。
- 下一步：用户试用删除流程；Windows 上试一次回收站。A2（首次启动加全局与单模型配置）仍待用户启动，需先问清范围。

## 2026-10-05 · 决定 52 Cloudflare token 权限误报排查与教程修正 · Claude
- 结论：不是程序误判。用用户桌面版保存的 token 只读探测 Cloudflare：verify 与 zones 为 200，但 dns_records、settings 均 403（错误码 10000）；用户在后台补齐权限并 Update token 后，一键配置第 4、5 步通过（未重新构建）。
- 第 5 步先报「token 无效」：根因是缺 Account 级隧道权限，且错误码 9109（无权访问资源）被 `BAD_TOKEN_CODES` 当成无效 token。已移出该集合，改为 forbidden（权限不足）。另把 `dns_records` 探测的 per_page 由 1 改 5。
- 新版 Cloudflare 界面每条 policy 只能选一种范围，实际需要 4 条：Entire Account · Cloudflare One Connector: cloudflared Write；Entire Account · Cloudflare Tunnel Write；All zones · DNS Read / Write；All zones · Zone Read。向导教程（`i18n/zh-CN.ts` howToken）、缺权限提示文字、README 已按此重写，并写明「Update token 才生效、Roll 后需重新粘贴」。
- 验证：新增测试 1 项（9109 判权限不足）；cloudflare 与 app 相关测试 102 pass / 0 fail；`bun run typecheck` 通过。用户手工在真实 Cloudflare 上跑通第 4、5 步。没验证：向导后续步骤（建隧道 / DNS / 公网访问）的完整走通、其他权限缺失组合的真实错误码。
- 过程注意：读取保存的 token 做探测，第二次被自动审批拦下，未绕过；探测只输出状态码，没有复述 token。cargo 改写的 Cargo.lock 已还原。
- 下一步：用户选择下一项（A2 首次启动配置加全局与单模型配置、A3 模型删除按钮，两项都需先问清范围）。

## 2026-10-05 · Mac 可用性、启动器、桌面壳 Mac 开发运行、首次按硬件调参、引导页、镜像兜底 · Claude
- 完成（均在 Mac 实测，Windows 未跑）：① `scripts/launch.ts` 统一 start.bat / start.command / `bun run start*`，默认运行桌面壳，`web` 只起服务；构建前自动 `bun install`（根因：旧 node_modules 缺依赖导致 Mac 构建失败）。② Rust 壳跨平台（job.rs 进程组、update.rs sha2、`BUN` 文件名、icon.png），`desktop/prepare.ts --dev`。③ 关键决定 54：首次按 Mac 内存 / Windows 显存或内存给上下文与批大小，settings v8（`setup.tuned`），额外参数精简为 `--no-prefill-assistant`。④ 引导页重做 + 左侧「新手引导」入口（无模型时显示）；修复 updater 冷却期状态「正在检查」。⑤ 关键决定 53：API 限流 / 不可达兜底（github-feed.ts）与公共镜像（mirrors.ts + MirrorChoiceModal），只在用户发起的更新失败后弹窗。
- 验证：`bun run typecheck` 通过；全部测试失败项与改动前一致（63 个，本机 Mac 原有：pre-commit 脚本、osascript / tilde 路径等），新增测试 mirror-fallback 8 项、分档与额外参数各项；`cargo test` 7 项；真实网络下三个镜像的元数据与下载 SHA-256 通过；被墙模拟下弹窗 → 镜像 → 安装成功。
- 没验证：Windows 上的启动器 / Rust 编译 / 首次调参；套壳窗口肉眼与正常关窗；大陆网络下镜像；llama-web 安装包经镜像；真实模型推理（本机无 gguf）。
- 发现的坑：Bun 的 fetch 不接受镜像的 `Location: /https://...`，mirrorFetch 自己跟随重定向；`cargo` 会改写 Cargo.lock 并去掉 `# pre-commit:allow` 注释，提交前需补回。
- 决定 / 待用户：分档数值待真实模型验证；是否给旧安装提供「按本机重新推荐」；Mac DMG / 签名 / 公证未启动。
- 下一步：用户在 Windows 上试 `start.bat`（桌面模式首次编译）；再决定上面的待办。

## 2026-10-05 · 试用问题记录：Cloudflare token 权限误报、更新检查限流 · Claude
- 问题 1：用户给 token 授予 DNS Read、DNS Write，一键配置仍提示「token 缺少权限：Zone · DNS · Edit」。记录为关键决定 52；探测在 server/core/cloudflare.ts（GET /zones/{id}/dns_records，403 判缺权限）。可能是 Zone Resources 范围或判断逻辑问题，尚未复现。
- 问题 2：检查更新常报「GitHub API 请求已被限流」，用户希望出错时换镜像站重试。记录为关键决定 53；更新源 / 下载域名目前限定官方 GitHub 且校验 SHA-256，加镜像要先和用户确认来源与校验方式。
- 本轮只记录（plan 决定 52 / 53、两条未完成任务、变更记录），没有排查或改代码。

## 2026-10-05 · 发布 v0.1.0-beta.5 + 记录两项后续需求 · Claude
- 发布：v0.1.0-beta.5（提交 4db38f5）由 Windows 草稿工作流构建成功，下载的安装包 SHA-256 与 SHA256SUMS 一致、清单 commit 正确后发布为预发布版。内容：启动器窗口不再一闪而过（见上一条）。
- 没验证：安装包实际安装 / beta.4 → beta.5 应用内更新、冷启动慢路径、真实模型 / GPU；macOS CI 仍失败（pre-commit 脚本测试，已知）。
- 新需求（只记录，没实现）：关键决定 50 首次启动配置加入全局与单模型配置；关键决定 51 模型删除按钮 + 二次确认，左下角勾选框可连模型 / 草稿 / 视觉文件一起删除（默认不勾；共享文件处理与永久删除范围需先问用户）。plan 阶段 8 已加对应未完成任务。
- 下一步：用户更新到 beta.5 试用；再决定是否做决定 50 / 51。

## 2026-10-05 · 8-feedback-desktop-window 补修：启动器窗口一闪而过 · Claude
- 背景：beta.4（f086a74）已发布，用户反馈仍有窗口一闪而过。截图是启动器窗口「正在启动本地服务……」：它启动即显示，主窗口加载完才隐藏，每次启动都会闪。上一次只修了启动器与主窗口同时可见，没修启动器本身一闪而过，修得不完整。
- 修复：tauri.conf 的 launcher 改为 `visible: false`。首次启动（choose）/ 导入恢复直接显示启动器；正常启动不显示任何窗口，直到主窗口加载完成；启动超过 2.5 秒（LAUNCHER_DELAY）仍无可见主窗口才显示启动器。失败、更新、二次启动路径不变。
- 验证：bun test 1097 pass / 0 fail；typecheck、cargo test --release 8 pass、git diff --check 通过；新增 3 项静态回归。发布版 exe 轮询：正常启动全程启动器 vis=False，仅主窗口显示；空数据目录（首次）0.45s 启动器可见。
- 没运行：安装包重打 / 安装、全新机器冷启动慢路径（2.5 秒后显示启动器）的真机观察、真实模型 / GPU。
- 下一步：需要新版本（beta.5）才能到用户手里；用户确认后再打包发布。

## 2026-10-04 · 阶段 8 用户反馈工作包：桌面版首次启动多余窗口 · Claude
- 起点：main b2cc414，工作区干净。只做本工作包；上下文、MTP、思考上限、启动失败提示相关代码未碰，没有启动审查、阶段 9 或发包。
- 根因（已复现）：不是第二个进程或重复创建。启动器窗口（tauri.conf 的 launcher，653×496）一直可见；服务 ready 后 `show_main` 新建的主窗口创建即可见，启动器要等主页面 `PageLoadEvent::Finished` 才隐藏，期间两个同名「llama-web」窗口同时可见。用 Win32 EnumWindows 每 15ms 轮询发布版 exe：修复前出现约 0.3 秒两个都 vis=True；WebView2 冷启动越慢窗口重叠越久，首次启动最明显。
- 修复（仅 `src-tauri/src/main.rs`）：主窗口 `.visible(false)` 创建；新增 `reveal_main`，页面加载完成时先显示主窗口再隐藏启动器（仅 phase=ready 且未退出时）；加载事件不触发时 10 秒兜底也走 `reveal_main`。二次启动（single-instance）只唤起可见的主窗口，否则唤起启动器。更新 / 失败 / 退出流程不变。
- 行为决定：无新增需要用户拍板的行为；加载期间用户继续看到启动器的「启动中」界面，而不是空白主窗口。
- 回归：新增 tests/desktop/window-lifecycle.test.ts 4 项（静态检查 Rust 源码：隐藏创建、唯一显示入口同时隐藏启动器、页面加载 + 兜底、二次启动选择）；Rust 窗口行为无法单元测试，靠下面的实测。
- 验证：bun test 1094 pass / 0 fail（75 文件，81s）；bun run typecheck 通过；cargo test --release 8 pass；git diff --check 通过。重新编译发布版 exe 后同样轮询两次：每次启动都先只有启动器，主窗口隐藏加载，再切换为仅主窗口可见，未再出现两个可见窗口（切换间隔在 15ms 采样内不可见）。
- 没运行：NSIS 安装包重打 / 安装、真正的全新机器首次启动（WebView2 冷启动、首次引导「choose」阶段点击开始）、真实模型 / GPU、Mac。实测用的是预置最小 settings.json 的隔离数据目录（跳过 choose 界面），窗口生命周期代码路径与首次引导相同（都经 start → show_main）。
- 清理：测试进程树已结束；cargo 改写的 src-tauri/Cargo.lock（去掉 pre-commit 注释）已还原；脚本与隔离数据目录在会话 scratchpad（仓库外）。
- 下一步：用户装新包试用确认首次启动只见一个窗口；需重打安装包才能让用户拿到修复（本工作包没有打包 / 发布）。MTP 真机验收、阶段 8 试用关口仍待处理，不自动进入阶段 9 或发包。

## 2026-10-04 · 阶段 8 用户反馈工作包：思考上限快捷设置 · Codex
- 起点：main 的 MTP 工作包提交 0e1f79e，起点干净。用户明确「跳过审查，下一个」，授权本工作包；没有启动独立审查、其他反馈或阶段 9。
- 完成：决定 47 任务已打勾。首次确认与方案参数编辑共用 ThinkingLimit；思考开启才显示「设置」，0 = 不限 → reasoningBudget -1，正整数 → token 上限；所有新文案在 i18n。
- 用户确认：只接受非负整数；关闭时仅隐藏入口，保留已设上限，重新开启继续使用。输入留空 / 负数 / 小数 / 非有限值不能保存；数值必须能精确表示为整数。
- 数据 / 兼容：沿用 overrides.reasoningBudget，不新增配置版本、持久化字段、迁移或依赖。保留当前方案的继承 / 自定义 / 不传；旧原始预算 0 未修改时继续表示关闭，打开抽屉 / 编辑其他字段不改写。快捷输入明确修改后才转换；原始参数的全局设置页沿用现状。
- 链路：setup.thinkingLimit → saveFirstSetup / applyFirstSetup 校验 → 原 JsonStore / writePair；编辑或预览 form.thinkingLimit → sanitizeForm 转换 → 原 saveProfile / previewLaunch；启动仍 planLaunch / buildLaunchArgs 的参数数组，关闭思考仍保存上限。
- 优先级：全局 / 方案手写额外参数保持原合并规则，不清理或改写；控件提示核对预览，冲突警告继续显示。思考上限只保存当前方案，不影响其他方案或全局预算。
- 保留：MTP 显式模式与共享草稿、首次上下文 / 全局 GPU 与 CPU 同步、useLive / useModelStartFeedback 失败提示；没有新增轮询、后台任务或资源。现有预览 debounce 仍在卸载时清理。
- 回归：新增 thinking-limit.test.ts 16 项，覆盖实际原子存储 / 重载、不限与正数参数、关开保留、上下文 + MTP 共存、预览不持久化、额外参数优先级、旧值 / 旧客户端及非法输入无写入。
- 最终验证：bun test 1039 pass / 51 skip / 0 fail（1090 项、74 文件、50.16s）；bun run typecheck、bun run build、git diff --check 通过。构建只有既有依赖的 DEP0155 弃用警告。
- 浏览器 / HTTP：隔离生产构建的构造 GGUF 验证默认 / 2048 首次保存、关闭时保存 512、关开保留 1024、0 转 -1、继承只读、手写参数覆盖及命令预览；旧原始 0 的无关编辑保留、真实键盘重新输入 0 转 -1；空 / 负 / 小数阻止保存，非法接口返回 400 且模型不变。
- 界面 / 既有功能：1280px 浅色与 375px 深色截图、首次 4096 / 4K、全局 GPU / CPU 上下文 4096、no-runtime 失败说明通过。控制台只见主动非法 POST 的预期 400，无脚本错误。
- 初跑失败：专项测试漏传目标 profile 导致 5 项失败，修正测试调用后全部通过；浏览器工具重复填同一值不发输入事件，改用真实键盘复验并保留原始 input 事件处理。最终无失败测试。
- 未运行：真实模型 / GPU 推理与 token 上限效果、运行库下载、Windows 安装包或 Mac 真机；未读取用户真实配置 / secrets。本次启动请求在隔离无运行库环境失败，未启动 llama-server。
- 清理：两次任务服务已停止，5303 无监听，测试标签页关闭、主题 / 视口恢复。自动审批拒绝删除 work/thinking-smoke 与 work/thinking-smoke.ts（blocked by policy），保留在会话工作区、仓库外且未提交；未绕过或清理旧 MTP 遗留。
- 下一建议：8-feedback-desktop-window（Windows 首次启动多余窗口），Opus 5.5，范围和提示词见 docs/claude-guide.html 对应卡片；用户另开会话启动。MTP 真机验收与阶段 8 试用关口仍待处理，不自动发包或进入阶段 9。

## 2026-10-04 · 阶段 8 用户反馈工作包：MTP 模式与草稿文件选择 · Codex
- 完成：决定 33 的 MTP 实现与构造数据 / 浏览器验收已打勾，真实模型验收拆成待验证项。首次默认关闭，开启后明确选自带或文件模式；两种模式填 N，文件模式另选同目录完整草稿。参数编辑共用控件，保存 / 预览 / 启动参数接通，所有新文案在 i18n。
- 用户确认：保持模型级共享 draft 和当前方案 extraArgs，不新增配置字段 / 迁移 / 依赖；切换自带 / 关闭清除共享文件，界面说明其他方案下次加载受影响。额外参数仍原优先级，控件只清理当前方案的 MTP / 草稿参数，不改全局文本。N 默认 3、1–16 整数沿用。
- 链路：首次 setup → saveFirstSetup / applyFirstSetup → validateMtp → 原 JsonStore 保存及上下文 writePair → 原后台 start；编辑 form.mtp → sanitizeForm → 新扫描 → saveProfile 同一 models.json 原子写入参数与共享文件。预览同样转换后走 previewLaunch，启动仍 planLaunch / buildLaunchArgs 参数数组。
- 兼容：未修改专用控件时保留旧手写参数 / 推测解码类型 / 草稿路径；已存配置直接可用。开启 MTP 的旧首次 POST 必须补 mtpMode，避免隐式模式；关闭时的旧请求仍可用。文件页签保留原行为；参数页 MTP 候选以已保存主模型为准。
- 保留：首次上下文 / 全局 GPU 与 CPU 同步、useModelStartFeedback / useLive 的异步失败弹窗；没有实现思考快捷上限、其他反馈或阶段 9。
- 验证：新 MTP 回归 23 项；最终 bun test 1023 pass / 51 skip / 0 fail（1074 项、73 文件、50.57s），bun run typecheck / bun run build / git diff --check 通过；清理后相关五文件专项 67 pass / 0 fail。
- 浏览器 / HTTP：隔离生产构建实测两种模式首次保存、文件 → 自带 N=6 → 第二文件 N=3 → 关、命令预览和磁盘一致；非法模式 / N / 文件不保存，跨站 403；取消 / Esc / 重开、Tab / 空格、375px 深色、4096 / 4K、8192 全局两份及 no-runtime 提示通过。控制台无 error / warn。
- 初跑失败：4 项为旧模式输入和关闭时 N 校验兼容问题，修正后通过；最终无失败测试。未测真实模型 / GPU、实际运行库下载、桌面安装包或 Mac 真机；未读用户真实配置 / secrets。
- 收尾：PID 25896 已停，5302 已释放，浏览器标签页关闭，主题 / 视口恢复。删除本轮夹具目录 / 脚本被自动审批拒绝（blocked by policy），保留在会话 work/mtp-smoke 与 work/mtp-smoke.ts（仓库外、未提交），未换方式删除；旧遗留目录没碰。
- 审查交接：docs/reviews/mtp-mode.md 包含范围、调用链、失败 / 兼容边界、验证与独立审查提示词；起点 a5271c4。本轮未启动任何审查任务。
- 下一步：独立审查本工作包及用户试用；真实 MTP 验收开始前先告知用户。反馈工作包无固定下一编号，不自动选择其他反馈、阶段 9 或发包。

## 2026-10-04 · 阶段 8 用户反馈工作包：首次启动上下文设置 · Codex
- 完成：决定 46 对应任务已打勾。首次确认框第一项为上下文，输入完整值并辅助显示 K；「设为全局配置」默认不选。所有新增文案在 i18n；未实现 MTP、思考上限或其他反馈。
- 用户确认：无论是否勾选，本次值都保存到当前方案；勾选时同步 Windows GPU / CPU 两份全局默认，Mac 更新唯一一份。其他模型 / 方案覆盖与额外参数继续按原规则优先。0 = 模型自带长度，留空 = 不传参数；沿用有限数字校验，没增加正数 / 整数政策。
- 调用链：首次 GET → previewLaunch → 运行库选择 / defaultsFor / 参数合并；首次 POST → saveFirstSetup → applyFirstSetup → JsonStore.update → 保存成功后 ctx.ops.start → planLaunch / buildLaunchArgs。后续 ModelEditor / saveProfile 编辑同一 overrides.ctxSize。保存前校验全部答案，全局写失败不改模型，模型写失败回退全局上下文字段，回退失败报告 AggregateError。无配置迁移或依赖变更。
- 验证：最终 `bun test` 1000 pass / 51 skip / 0 fail（1051 项、72 文件、51.27s）；`bun run typecheck`、`bun run build`、`git diff --check` 通过。新增上下文专项 22 pass / 0 fail；保留上一工作包的启动提示回归。清理测试服务后全量及类型检查再次通过。
- 浏览器 / HTTP：隔离生产构建实测 4096 / 4K 本地保存、12288 全局同步并在 GPU / CPU 设置页显示、6144 后续编辑与继承 12288 的命令预览；取消 / Esc、重开重置、留空 / 0、极小值 K、Tab / 空格、浅色 / 375px 深色、确认后 no-runtime 弹窗。HTTP 四种非法上下文 400、跨站写入 403，两份配置未变；本地 / 全局 / 0 / 继承 / 未确认状态有文件断言。
- 过程中失败：专项初跑 2 fail（测试回调误返回 Profile、误认为旧覆盖参数仍保留），修正后通过；一次构建因本轮运行的服务占用 sharp DLL 报 EPERM，停服务后重建通过。最终没有失败测试。
- 未验证：真实模型加载 / GPU 推理、真实运行库下载、桌面安装包重打 / 安装、Mac 真机。Mac 仅构造数据验证；两文件保存延续现有尽力回退能力，不保证断电 / 强制终止的跨文件事务。没有读取用户实际配置或 secrets。
- 收尾：本轮两次测试服务（PID 44368 / 23312）已停止，5301 端口释放，浏览器主题 / 视口恢复且标签页关闭。删除临时目录被自动审批拒绝（blocked by policy）；夹具 / 脚本 / 日志保留在忽略的 `.data/first-context-smoke-20261004-b47a/`，未换方式删除或提交；两张截图保留在会话产物。此前遗留目录未触碰。
- 独立审查交接：`docs/reviews/first-start-context.md` 包含范围、调用链、验证、失败边界和审查提示词；起点 `25980a6`，用 `git diff 25980a6..HEAD`。本轮只准备交接，未代替独立审查。
- 下一步：独立审查本工作包并由用户试用确认；反馈工作包没有固定的下一编号，不自动选择其他反馈或进入阶段 9 / 发布安装包。

## 2026-10-04 · 阶段 8 反馈修复：模型启用 / 启动失败提示 · Codex
- 完成：阶段 8 首项用户反馈已打勾。启用、首次确认读取 / 保存、手动启动及重试失败统一弹窗；缺运行库时提供「前往下载 llama.cpp」，其他已识别原因连接到运行库、模型参数、目录、服务设置或过滤日志。所有新增文案在 i18n。未实现其他反馈项。
- 根因：启动 / 重试 / 首次确认接口立即返回 ok，实际启动在后台；缺运行库发出 loading → stopped（error=no-runtime）并移除实例，仅捕获 HTTP 或查看 failed 实例会漏报。
- 实现：`useModelStartFeedback` 关联用户操作后的 model/profile 活动事件，去重历史事件，兼容错误先于 HTTP 返回、旧失败重试和快照回退；布局统一跟随 `useLive` 并承载弹窗，首次确认框卸载不丢提示。ModelEditor 支持定位方案与参数页；设置页等待卡片出现后处理 hash。未改服务端状态机、API、配置结构或依赖。
- 验证：最终 `bun test` 978 pass / 51 skip / 0 fail（1029 项、71 文件、51.08s）；`bun run typecheck`、`bun run build`、`git diff --check` 通过；收尾 `bun test tests/app/model-start-feedback.test.ts tests/app/model-start-notice.test.ts` 15 pass / 0 fail。隔离浏览器实测首次确认后 no-runtime、普通启动、坏参数重试、正确方案参数抽屉、运行库分区定位、过滤日志、Esc / 关闭按钮 / 键盘导航、深浅色与 375px 窄屏。
- 过程中失败：首次回归先复现 3 项缺失提示；自查修正关闭按钮类型错误与测试用例范围。首次全套遇到测试 LiveHub 夹具的延迟回调错误，修复后两次等待 unref 计时器的试跑卡住并主动中止；修正夹具等待方式后完整回归通过。生产逻辑未受该夹具问题影响。
- 没跑：桌面安装包重打 / 安装、真实运行库下载、真实模型加载 / GPU 推理、Mac 真机。ready 成功路径与 Mac 对应文案由构造数据测试。用户真实配置和 secrets 未读取或修改。
- 收尾：本轮自己的测试服务及子进程已停止、3000 端口释放；删除临时夹具 / 脚本 / 日志被自动审批拒绝（blocked by policy），留在忽略的 `.data/model-start-smoke-20261004-a91f/`，未换方式删除或提交。浏览器截图作为审查证据保留在会话产物。原工作区 plan / handoff 的需求记录一并保留，除本项外均仍待实现。
- 审查交接：`docs/reviews/model-start-feedback.md` 提供范围、验证和 Claude 提示词；起点 `0786d2b`。本轮不代替 Claude 独立审查。
- 下一步：按用户要求先让 Claude 审查本项；确认后再选阶段 8 反馈工作包（建议首次启动上下文设置）。不自动进入阶段 9 或发布新安装包。

## 2026-10-04 · 后续需求记录：GPU / CPU 设备不匹配提醒 · Codex
- 需求：在全局默认参数页面保存时检查配置类型和设备。GPU 版配置选 CPU、或 CPU 版配置选 GPU 时给出提醒，但允许用户确认后继续保存。
- 记录位置：`docs/plan.html` 关键决定 49。用户要求本轮只加入后续需求，留给后续 AI 处理。

## 2026-10-04 · 后续需求记录：网页对话调试模块 · Codex
- 需求：在 llama-web 中加入类似小型 ChatGPT 的网页对话模块，直接使用 llama.cpp 服务与模型对话，方便用户调试。
- 记录位置：`docs/plan.html` 关键决定 48。用户要求本轮只记录，具体工作留给后续 AI 处理。

## 2026-10-04 · 试用反馈记录：桌面版首次启动双窗口 · Codex
- 反馈：Windows 桌面版第一次启动时短暂出现两个 llama-web 窗口，其中一个很快消失（一闪而过）。截图显示两个同名窗口重叠；目前原因未知。
- 期望：找出多余窗口的来源并修复，启动时只显示预期的主窗口。
- 记录位置：`docs/plan.html` 阶段 8「用户试用反馈 · 待处理」。本轮只记录，没有排查或修改代码。

## 2026-10-04 · 试用反馈记录：思考最大上限设置 · Codex
- 需求：思考开关为开时提供「设置」入口，让用户输入思考最大上限数字；思考关闭时不显示该入口。用户不需要填写参数名。
- 默认输入为 `0`，表示不限制，保持当前行为并映射到 llama.cpp 的 `--reasoning-budget -1`；用户填正数时由程序拼接参数覆盖上限。
- 记录位置：`docs/plan.html` 关键决定 47 与阶段 8「用户试用反馈 · 待处理」。本轮只记录计划，未修改代码或验证行为。

## 2026-10-04 · 试用反馈记录：首次启动上下文设置 · Codex
- 需求：在首次启动确认框增加上下文设置，排在第一项。输入框显示完整数值，旁边以 K 简写显示（例如 4096 / 4K）。
- 输入框下增加「设为全局配置」选项；选中后，全局配置中的上下文统一使用此数值。
- 记录位置：`docs/plan.html` 关键决定 46 与阶段 8「用户试用反馈 · 待处理」。本轮只记录计划，未修改代码或验证行为。

## 2026-10-04 · 试用反馈记录：内置 MTP 与草稿文件选择 · Codex
- 反馈：部分模型即使没有单独的 MTP 草稿文件，也自带 MTP（例如 Qwen）；当前确认框把「没有候选文件」当作内置 MTP，未让用户明确选择模式。
- 期望：MTP 先由用户选择开 / 关；开启后再选「模型自带 MTP」或「草稿模型文件」。自带模式只填数字 N，生成 `--spec-type draft-mtp --spec-draft-n-max N`（用户示例 N=4）；文件模式从同目录候选中选文件并填 N（用户示例 N=3），再加 `--model-draft "文件路径"`。两种模式都不要求用户填写原始参数，也不自动推断模型能力。
- 记录位置：`docs/plan.html` 关键决定 33 与阶段 8「用户试用反馈 · 待处理」。本轮只记录 / 修订计划，没有改代码或验证实现。
- 后续验证：分别用支持内置 MTP 的模型和带草稿文件的模型检查参数、首次确认保存与之后编辑。

## 2026-10-04 · 试用反馈记录：首次启用失败提示 · Codex
- 反馈：用户第一次启用模型时没有成功，反复点击后才发现尚未下载 llama.cpp。
- 期望：启用失败必须弹窗说明具体问题；如果是缺少 llama.cpp / 可用运行库，弹窗应提供「前往下载 llama.cpp」操作，直接打开设置页的运行库管理 / 下载区域。其他可识别的启动问题也应给出针对性说明和处理入口。
- 记录位置：`docs/plan.html` 阶段 8「用户试用反馈 · 待处理」。此项未实现、未验证，不能标记完成。
- 下一步：用户确认进入修复后，按阶段 8 反馈项实现并验证；此轮只记录文档。

## 2026-10-03 · 发布 v0.1.0-beta.3 · Codex
- 完成：按用户「结合提交记录发布新版本」要求，将 package.json 更新为 0.1.0-beta.3，新增 `docs/release-notes/v0.1.0-beta.3.md`。涵盖 beta.2 后阶段 7 / 8 的实际实现，不把阶段 9 规划写成已实现。Windows 草稿经验证后已发布为未签名 prerelease；tag → `4ceb66b`，发布页：https://github.com/egoist74110/llama-web/releases/tag/v0.1.0-beta.3 。
- 本地验证：`bun test` 963 pass / 51 skip / 0 fail（1014 项、69 文件，71.22s）；`bun run typecheck`、`git diff --check` 通过。Windows 发布工作流 run 37130153827 成功：`bun test` 1014 pass / 0 fail，typecheck、`desktop:build`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`（8 pass）、资源 / 安装包检查通过。
- 下载包验证：`gh release download` 后，安装包与 SHA256SUMS、GitHub digest、manifest 的版本 / 提交 / 大小一致；本地 `bun desktop/check-package.ts <installer>` 检查 376 文件通过。隔离目录静默安装（/S /NS）、实际桌面壳启动；四页面及 `/api/system`、`/api/usage`、`/api/llamacpp`、`/v1/models` HTTP 200；构造 settings v4 → v7、app-update v1 → v2 迁移正确，原启动参数保留；正常关窗后服务退出、端口释放；静默卸载保留夹具数据。没有加载模型或占用推理 GPU。
- 公开验证：匿名公开下载的安装包与已验草稿一致；发布说明正文一致（仅 Windows CI 的 CRLF 差异）；公开 API 用实际 `pickUpdate` 验证 beta.2 → beta.3、beta.3 无更新、正式版 0.1.0 不接收预发布，5 个资产齐全。
- 失败与范围：第一次安装冒烟的测试脚本写错主程序名，安装 / 卸载成功但启动检查失败；改为从安装登记读取实际名称后全程重跑通过。第一次正文对比因 CRLF 差异失败，归一化换行后通过。现有 macOS CI 933 pass / 19 skip / 62 fail / 1 error，未修复或宣称 Mac 已支持。本轮没测真正多卡、Mac 真机、干净 Windows / 无 NVIDIA、安装版完整视觉交互、真实模型推理、实际 beta.2 → beta.3 自动升级。
- 收尾：只使用构造的用户数据，未读真实 secrets；测试安装、运行缓存、测试进程已清理，原 NSIS 登记导出与基线逐字一致。删除本次临时验证目录的命令被自动审批拒绝（仅返回 `blocked by policy`），所以下载包、构造数据、验证脚本及登记备份留在忽略的 `.cache/release-beta3/`，未提交；没有换方式绕过。清理后的 `bun test tests/core/app-update.test.ts` 24 pass / 0 fail。发布产物保留在 GitHub，计划与桌面验证记录同步。
- 下一步：阶段关口 8，请用户试用新包（版本管理 / 默认参数与设备 / 用量 / 更新开关 / 临时隧道）；不自动进入阶段 9 或发布 Mac 安装包。

## 2026-10-03 · 工作包 8-7 · Sonnet 5.5
- 完成：plan 8-7 四项打勾。`server/core/gpu-group.ts`：设备选择 5 个字段（`device` 单选 + 可选 `devices` / `splitMode` / `tensorSplit` / `mainGpu`），同一层里单选与设备组二选一，第一个有选择的层整体生效；校验：两张以上才算组、一张等于单选、组里不能有 auto / cpu、比例个数 = 设备数、主 GPU 序号 < 设备数；自动在列表有两张以上 GPU 时取显存最大的一张，一张或读不出列表时命令与以前完全相同。`LaunchPlan` 加 `devices` / `group` / `combo` / `autoPicked` / `resolve(info, record)`（启动前对照设备列表与 `--help` 的切分模式：缺设备 `device-missing`，模式不支持 `split-mode-unsupported`）；context 的 `launch` 对非 CPU 都探测设备列表（60 秒缓存）；`devices.ts` 解析 `--help` 的 `--split-mode {…}` 并按可执行文件缓存（`/api/devices` 多返回 `splitModes`）；`split-stats.ts` 管 `data/split-modes.json` v1（已确认 / 已失败，只存 id、版本标签、数字）；row / tensor 加载失败且原因不是显存 / 超时 / 文件 / 参数时包成 `SplitModeLoadError`，诊断为 `split-mode-failed` 并记入失败，之后预览与启动前警告，加载成功后清除；接口 `GET/POST /api/devices/split`；全局默认、`/api/models/:id/device`、方案保存都接受 5 个字段（整体替换），Mac 拒绝。界面 `DeviceChoice.vue`：单选下拉 +「使用多张 GPU」开关（默认关）；打开后 GPU 复选列表（至少留一张）、切分模式、比例（占位 = 各卡显存 GiB，提示占比）、row 才有主 GPU；row / tensor 标实验性并在首次选用时弹确认；接入全局默认、模型框、方案表单；文案在 `rd.gpu` / `warnings` / `loadError` / `failure.advice`。
- 验证：`bun test` 1014 通过 0 失败（新增 `tests/core/multi-gpu.test.ts` 32 个、`tests/app/gpu-choice.test.ts` 6 个，多卡路径用构造的设备列表）；`bun run typecheck` 通过。界面在源码版（临时数据目录）看了全局默认的开关与 GPU 列表、`/api/devices/split` 查询 / 确认、带设备组的命令预览。**真机（用户同意；RTX 5090，b11146，Qwen3.8-27B Q4 17 GB，`-c 2048`）：** `--device CUDA0` 配 `--split-mode none` / `layer` / `tensor` 都能加载（显存 +17.0 GB；tensor 有警告：不支持 `--fit`、单设备不推荐）；`row` 单卡加载失败 `device CUDA0 does not support split buffers`（退出码 1，会诊断成 exited）；`--main-gpu 1` 在只有一个 `--device` 时报 `invalid value for main_gpu: 1 (available devices: 1)`，所以序号相对 `--device` 过滤后的列表（主 GPU 存的是组内位置）；`--tensor-split 1,1` 配单设备也能加载。每次就绪后立即结束，无残留进程；临时目录与 junction 已清理（先 `rmdir` 链接，真实运行库完好）。
- 没测：**任何真正的多卡**（只有一张卡）：`--device a,b`、layer / tensor 切分的实际效果与性能、比例、row 的主 GPU、P2P / NCCL（不自动设）；Mac；确认弹窗、深色 / 窄屏、模型抽屉与方案表单里的新控件（只看了全局默认）；经界面保存全局 / 模型 / 方案的完整往返；真实触发一次 `split-mode-failed` 看失败卡片。
- 决定 / 坑：① 没有 settings 迁移：旧 `device` 保留，新字段可选，旧配置原样有效（计划写的「旧单设备值 → 只含它的设备组」没有照字面做，行为等价）。② 确认只在界面里选 row / tensor 时弹，服务端只记录；手改配置用未确认组合只会得到启动警告，不拦。③ 失败记忆的键 = `加速类型:版本标签|有序设备|模式`，换 llama.cpp 版本要重新确认。④ 自动现在每次启动前都先跑 `--list-devices`；失败 / 读不出列表就保持原来「什么都不传」。⑤ `extra-multi-device` 文案改成泛指设备 / 切分参数。⑥ 顺手修了 `SettingsDefaults` 设备列表在平台信息晚到时不加载的老问题。⑦ 模型抽屉里「继承」只写「跟随上一层」，不显示上一层是不是设备组。
- 剩余：无（8-7 范围内）；阶段 9 的逐卡显存估算用 `plan.group` / `plan.devices`。
- 下一步：**阶段关口 8** —— 请用户试用（含 Mac 真机，如有）；不自动发版。

## 2026-10-03 · 自动更新开关与版本旁提示 · Codex
- 完成：按用户最终说明更新决定 15 / 29。llama.cpp 自动更新默认关（settings v7 迁移为关，保留其他配置）；llama-web 自身默认开启检查与自动安装（app-update.json v2 迁移开启，保留跳过版本）。两者关闭自动更新仍每天检查，只提示、不自动安装。检查尝试 / 结果跨重启保存，失败也计入 24 小时间隔；运行库新增运行期间计时，手动检查可绕过间隔且只读元数据。
- 界面：两张设置卡都有自动更新开关与旁边的「检查更新」按钮；运行库可显式下载。应用与运行库版本旁显示新版提示，侧栏 / 总览 / 版本列表接实时状态；移除 AppUpdatePrompt 的自动打开和横幅，保留用户主动安装的确认框。主通道与已安装次通道可检查、下载，尚未安装次通道不自动下载，手动添加的版本不自动更新。
- 安装：桌面应用自动下载继续比对 GitHub SHA256 摘要和 SHA256SUMS，安装前复核，沿用私有管道与桌面壳再次复核 / 被动安装 / 重开流程。关闭开关、跳过版本、退出可阻止后续自动安装；校验失败或壳交接失败保留错误状态。源码版没有 installer 回调，只链接发布页。运行库已有回退 / 下载中手动选择 / 在用目录保护保持原规则。
- 验证：最终 `bun test`：925 pass / 51 skip / 0 fail，67 文件，72.78s；`bun run typecheck` 通过；`git diff --check` 通过。新增回归覆盖开关、迁移、跨重启缓存、关闭仍每日检查、运行期间计时与停止、下载中关闭 / 退出、坏摘要与安装交接失败。手动应用检查会等待自动安装，因此前端允许等待期间修改偏好 / 取消下载，同时合并重复动作，新增实际 composable 行为测试。曾出现两处联合类型收窄错误与旧版本号测试断言，已修正并重新通过。
- 没跑：build / 桌面打包、浏览器深浅色 / 窄屏、真实下载与安装、GPU / 推理、Mac 真机。现有运行服务未重启；没有读取真实 secrets / 配置或触发真实安装。测试只用构造数据，测试计时器在 teardown 停止。
- 相邻改动：保留工作区已有的 models.addDir 文案层级修正并纳入提交，否则 8-6 基线里的 ModelAddDir 找不到文案、类型检查失败；没有改动其目录添加逻辑。
- 收尾：README / 计划 / 交接已同步；停在本次更新修正，不自动进入下个阶段。下一步请重启源码服务试用两个开关与版本旁提示；新版桌面包及实际自动安装流程仍待后续打包验收。

## 2026-10-03 · 工作包 8-6 · Sonnet 5.5
- 完成：plan 8-6 第 1 项和 Mac 专项收尾里的两项打勾。模型页「添加目录」（`ModelAddDir.vue`：选目录 / 旁边「输入路径」粘贴；`app/utils/model-dirs.ts` 判断重复和「已被某目录包含」；添加后切到「扫描发现」、扫描并提示找到几个；空状态也有按钮；`DiscoverPanel` 暴露 `rescan()`，同时进行的扫描会合并）。扫描跳过 `._*` / `.DS_Store`；`expandHome`（`~` 展开）；`folder-picker.ts` 加 osascript（标题走参数不拼进脚本，取消 = null），`/api/fs/pick-folder` 和 `canPickFolder` 对 Mac 打开；Mac 文案审计（`i18n` 的 `platform.mac` + `app/utils/platform-text.ts`，参数说明 / 内存不足提示 / 路径示例 / 重启提示 / 图片说明用 Mac 版，总览显存卡加平台判断，删掉未使用的 `macHint`）；`start.command`（+ `.gitattributes` 保持 LF，提交时设了可执行位）、`.github/workflows/ci.yml` 的 macOS 作业 + `scripts/ci-llamacpp-smoke.ts`、README 的 Mac 段、`docs/platform-foundation.md` 补验证范围。
- 验证：新增测试 `scanner`（`._`）、`folder-picker`、`settings-admin`（`~`）、`app/model-dirs`、`app/platform-text`、`platform/start-command`，我这部分的相关测试全部通过。源码版（`nuxt dev`，临时数据目录）里在浏览器走了：粘贴路径 → 添加 → 自动切到扫描发现，`._` 文件没出现；换大小写 + 结尾斜杠再添加 → 提示「已经在列表里」。`bun run typecheck` 在我改的文件上无报错。
- 全量状态（如实）：`bun test` 948 通过 / **12 失败**，`typecheck` 有 3 处报错，**全在同时进行的另一个会话的未提交改动里**（llama.cpp 自动更新改成默认关闭、settings v7、`LlamacppUpdateControls.vue`、`updater.ts`、`app-update.ts`、`download.post.ts` 等，不是 8-6 的文件）。我只提交了 8-6 的文件；`i18n/zh-CN.ts` 里两边的改动混在一起，只提交了我的几段。
- 没测：真机 Mac 上的一切（osascript 弹窗与权限提示、`start.command` 的 Finder 双击与 PATH、Metal 推理、sharp 原生安装）；macOS CI 作业还没在 GitHub 上跑过（含真实 macOS 版 llama.cpp 的 `--version`，且 `bun test` 在 Mac 上是否全过未知）；系统选择窗口没有点；没有用模拟的 Mac 平台逐页再看一遍界面。
- 决定 / 坑：① 「输入路径」按钮在所有平台都有（远程用 LAN 地址访问时选择窗口会被拒，只能粘贴）。② `app/utils` 里要被测试导入的文件必须用相对路径导入 i18n（`~~` 在 `bun test` 里解析不了）。③ Mac 文案测试允许字面的 `--n-gpu-layers` 这类 llama-server 参数名。④ plan 里 Mac 专项的「界面隐藏清单」「遗漏项审计」没打勾（需要真机 / 模拟平台逐页核对）；`docs/platform-foundation.md` 的「不宣称 Mac 已支持」保持不变。
- 剩余：Mac 真机验证项（见「没测」）；`start.command` / osascript / macOS CI 在 plan 里保持未勾。
- 下一步：8-7（多 GPU，Opus 5.5，指南 #p8-7）；实测前先告诉用户。8-7 完成后才是阶段 8 关口。

## 2026-10-03 · 工作包 8-5 · Sonnet 5.5
- 完成：plan 8-5 三项打勾。设置页：新「本机」卡片（`SettingsSystem.vue`，`GET /api/system`，重新检测、推荐与警告；Mac 只显示芯片 / 型号 / 核心 / 统一内存 / macOS）；llama.cpp 卡片重写（`SettingsLlamacpp.vue`：Windows 分「NVIDIA（CUDA）版 / CPU 版」两个通道，CPU 通道没装时有下载按钮；Mac 单通道、不写通道名；添加版本 `RuntimeAddModal.vue`——三个来源，先弹「会运行你选的程序」再预览，预览页显示大小 / 版本号 / SHA-256 / 警告，没公布摘要要勾选确认，关闭或取消会丢弃暂存；删除 `RuntimeDeleteModal.vue`——先取 delete-plan，列出受影响的模型 / 方案和当前版本变化；最新官方版删除按钮禁用并有说明；`runtime-fallback` 事件做成提示条）；全局默认（`SettingsDefaults.vue`）Windows 有「GPU 版 / CPU 版」两个标签，GPU 版带全局设备下拉，CPU 进阶（线程 / NUMA / 掩码）折叠；编辑抽屉：参数页顶部 `ModelRuntimeBox.vue`（模型级版本 / 设备，各自保存，可保存并重启），`ProfileForm.vue` 里方案级版本 / 设备下拉、CPU 进阶折叠区（检测到多路 CPU 或已设置时默认展开）、命令预览下显示实际使用的版本 / 设备 / 兜底。平台开关集中在 `app/utils/platform-ui.ts`（`usePlatformUi()`），文案在 `i18n/zh-CN.ts` 的 `settings.system`、`llamacpp.manage`、`models.edit.rd`、`settings.defaults`。
- 验证：`bun test` 939 通过 0 失败（新增 `tests/app/runtime-choices.test.ts`：平台开关、Mac 无加速字样、版本 / 设备选项）；`bun run typecheck` 通过。界面在源码版（`nuxt dev`，临时数据目录、关自动更新）里看过：浅 / 深色、窄屏（390 宽）；真实走了一遍「目录 → 预览（运行真实 `--version`）→ 添加 → 删除」，错误路径（路径不存在）；设备下拉列出本机显卡。Mac：浏览器里把 `/api/system`、`/api/devices`、`/api/settings`、`/api/llamacpp` 的响应和实时快照的平台改成构造的 darwin 数据，设置页和编辑抽屉里没有设备 / 通道 / GPU 标签 / CPU·GPU 切换；用脚本扫了页面文字，剩下的 GPU / 显存字样都是原有的参数说明和别的卡片（见下）。临时数据目录已删。
- 没测：真实 GitHub 下载、压缩包来源（只测了目录）、「下载 CPU 版」按钮、切换另一通道版本（secondary）、兜底提示条（只看代码）、删除时有受影响模型的列表（只看代码）、「保存并重启」、真机 Mac。
- 决定 / 坑：① 选择压缩包没有文件选择窗口，只能粘贴完整路径（服务端没有 pick-file 接口，不在本包范围）；选择文件夹按钮只在 Windows 出现，Mac 的 osascript 留给 8-6（把 `platform-ui.ts` 的 `canPickFolder` 打开即可）。② Mac 上仍能看到的 GPU / 显存字样：全局默认参数里「GPU 层数」「省显存」等原有说明、总览 `macHint`、`platform.runtimeHint`（本卡里 Mac 不渲染）、调度设置里「显存有限」——8-6 的文案审计要处理。③ 模型编辑抽屉里「继承」显示的默认值仍取主通道那份（8-2 的遗留 ⑥ 未改）。④ 「全局设备」只在 GPU 版标签里；`defaultsCpu.device` 不开放。⑤ `usageKeepDays` 仍没有界面（8-4 遗留，用户定）。⑥ 本机卡片的 Mac 内存提示沿用服务端文案。
- 剩余：无（8-5 范围内）。
- 下一步：8-6（Sonnet 5.5，指南 #p8-6）。

## 2026-10-03 · 更新检查修正 · Codex
- 完成：按用户要求更新决定 15 / 29。llama.cpp 各官方通道与应用自身自动检查每 24 小时最多一次；新文件 `data/update-checks.json`（v1）经 JsonStore 原子写入、保留 3 份备份，在请求之前记录尝试时间，失败 / 中断也计入，重启不重复检查。应用保持每天的运行期间检查；llama.cpp 保持只在启动时检查。手动应用检查 / 显式运行库下载绕过间隔。已有回退选择与运行中的模型保持原有行为。
- 原因：用本机 Node fetch 请求日志所列 GitHub API，实际返回 HTTP 403、`x-ratelimit-remaining: 0`；原代码把所有 HTTP 错误归为 network，细节只留下 URL。现在区分 network / rate-limited / http；支持主要限流响应头、429 和 403 的 secondary rate limit 消息，不输出响应正文。中文提示同步更新。
- 缓存：应用只保存选中的发布说明与相关资产，重启可保留更新提示和下载所需校验信息；应用版本改变时不复用上个版本的检查结论。CPU / GPU / 应用通过各自的 key 分开节流，同步更新前读盘，避免彼此覆盖。
- 验证：先运行专项测试复现 3 fail；修复后专项 `bun test tests/core/update-check.test.ts tests/core/updater.test.ts tests/core/app-update.test.ts tests/core/llamacpp.test.ts` 56 pass / 0 fail。最终 `bun test` 888 pass / 51 skip / 0 fail（61 文件，74.44 秒），`bun run typecheck`、`git diff --check` 通过。覆盖重启、失败计入、24 小时到期、回退保持、显式检查、跨通道写入、时钟回拨、缓存下载校验、限流识别与退出取消。
- 没测：真实大文件更新下载 / GPU / 安装包 / 浏览器；没有 build。GitHub 当前限流仍需等待配额恢复；本次修正检查频率与错误提示，不改变 GitHub 配额。没有修改真实配置、读取 secrets、引入 token / 镜像或安装依赖。
- 工作区：并行的 8-4 已提交，8-5 界面正在改；只提交本轮更新文件与公共文案中的对应片段，保留其余界面改动。测试临时目录由测试清理，未启动长驻服务。
- 下一步：继续原工作包 8-5（Sonnet 5.5，指南 #p8-5），本轮只做更新修正，不启动后续工作包。

---

## 2026-10-03 · 工作包 8-4 · Sonnet 5.5
- 完成：plan 8-4 三项打勾。`server/core/usage.ts`（`UsageStore`：按「小时 × 模型 × 方案 × 来源 × key」内存累加，30 秒定时 + 退出时原子写 `data/logs/usage/YYYY-MM-DD.json`，同一天重启会接着旧文件；只存计数；半写 / 损坏 / 非法行读取时跳过；`prune()` 只删符合 `YYYY-MM-DD.json` 的超期文件，启动时和跨日时清理；报表与 CSV）；`logs.usageKeepDays`（默认 30，规整为 7 / 14 / 30，旧配置自动补，无需迁移）；`GET /api/usage?from&to[&format=csv&groupBy=]`（范围最多 62 天；CSV 加 BOM，以 `= + - @` 开头的单元格加 `'` 防公式注入）；日志页「用量」标签（`UsagePanel.vue`：汇总卡、每日 token 柱图、按模型 / 来源 / key / 方案表、导出 CSV）；`context.ts` 里和请求日志共用同一条记录（`onRequest`），退出时 `usage.close()`。文案在 `i18n/zh-CN.ts` 的 `usage`。
- 验证：`bun test` 923 通过 0 失败（新增 `tests/core/usage.test.ts` 23 个：聚合、跨日、清理边界、半写文件、CSV、设置规整）；`bun run typecheck` 通过。没有运行：界面（浏览器里看过柱图 / 窄屏 / 深色）、经 HTTP 的 `/api/usage`、真机。
- 决定 / 坑：① 保留「含今天共 N 天」（日志的 keepDays 是 N+1 天，这里按「近 30 天」口径）。② 没有解析出模型的失败请求也计入（模型为空）；`GET /v1/models` 本来就不产生记录，不计。③ 请求按到达时间归日 / 小时（本地时区）。④ 设置里还没有 `usageKeepDays` 的界面（接口也不开放），只能改 settings.json；要不要放进设置页由 8-5 / 用户定。⑤ 用量页提示文案里的「30 天」是写死的，没读设置值。
- 剩余：无（8-4 范围内）。
- 下一步：8-5（Sonnet 5.5，指南 #p8-5）。

## 2026-10-03 · 阶段 8 审查意见处理（8-1 至 8-3）· Sonnet 5.5
- 范围：处理 `docs/reviews/stage-8-codex.md` 的 7 条意见（S8-001 至 S8-007）。逐条对照代码核实，全部成立，已修复并补测试；每条的处理结果写在审查文件该条的「缺失测试」之后，文件头有汇总。没有「不成立」，没有需要用户决定的项。本次不打勾，不改计划（没有新增或变更的决定）。
- 修复：S8-001 解压前按 `tar -tv` 列表预检展开大小 / 条目数 / 可用空间，解压中每 100 毫秒复核实际写出量（`archive.ts`，新错误码 `extract-too-large`）；S8-002 `context.ts` 在 `planLaunch` 之后、设备探测之前登记运行库保护，`try/finally` 释放；S8-003 `runtime-manager.ts` 删除时后续写入失败，依次还原登记、模型 / 方案引用、目录；S8-004 缺失的自定义运行库按登记条目的类型兜底（`resolveRuntimeRef`）；S8-005 迁移 5→6 对 `acceleration: 'cpu'` 的安装用旧 `defaults` 初始化 `defaultsCpu`；S8-006 `buildLaunchArgs` 返回额外参数覆盖后的有效设备（`extraDevice`），`planLaunch` / `previewLaunch` 的 `device` 用它；S8-007 每次预览独立 `AbortController`，`cancel()` 中止进行中的导入（下载 / 解压 / `--version`），新错误码 `cancelled`（接口 409，文案「已取消添加。」）。
- 验证：`bun test` 900 通过 0 失败（58 个文件）；`bun run typecheck` 通过。S8-002 的测试已确认在没有修复时失败。没有运行：真机 / GPU、HTTP 端到端、界面、macOS。
- 已知边界：① S8-001 的写盘监视是 100 毫秒轮询，间隔内仍可能多写一小段。② S8-003 没有跨重启的持久化操作记录，进程在三次写入之间被杀仍可能留下中间状态。③ S8-005 对 `acceleration: 'auto'` 的 v5 用户不复制旧 defaults（迁移时无法知道本机实际用 CPU 还是 GPU）。④ `launch-protection.test.ts` 只在 Windows 运行。⑤ 8-5 界面要处理新错误码 `cancelled`（文案已在 `i18n/zh-CN.ts` 的 `add`），取消按钮现在对进行中的导入也有效；调用 preview 前仍须先弹「会运行你选的程序」确认（审查文件「执行确认的已知边界」）。
- 提交说明：开始时工作树里另有别人（Codex）未提交 / 已暂存的改动（局域网地址相关：`network.ts`、`live.ts`、`overview` 等，以及 `docs/plan.html`、`context.ts` 里的对应片段）。本次只提交了自己的文件和 `context.ts` 里自己的那一段，其余原样保留。
- 阶段 8 剩余：8-4（用量）、8-5（界面）、8-6（Mac 联调）、8-7（多 GPU）仍按 `docs/plan.html`；下一个工作包按 `docs/claude-guide.html` 的阶段 8 卡片。

## 2026-10-03 · 总览局域网 API 地址 · Codex
- 完成：本机打开总览时，API 地址用服务端主网卡 IPv4 + 页面实际端口；局域网地址 / 公网域名继续使用原地址，隧道展示不变。`network.lanHost` 经 LiveHub 的 snapshot 推送，页面不新增请求或轮询。默认路由通过不发送数据的 UDP connect 探测，失败时优先物理网卡、排除回环 / 链路本地地址；找不到可用 IPv4 保留原地址。Nuxt 开发监听改为 `0.0.0.0`，匹配正式主入口。同步决定 20、接口说明和阶段 2 完成项。
- 验证：专项 `bun test tests/core/network.test.ts tests/core/live.test.ts tests/app/overview.test.ts` 38 pass；最终 `bun test` 849 pass / 0 fail / 51 skip（包含同时进行的运行库修正）；`bun run typecheck`、`git diff --check` 通过。真实默认路由探测选中主网卡；`/api/state` 有 LAN 地址，本机通过该 IP 请求 `/v1/models` 返回 200 / JSON / 3 个模型，IPv4 回环也返回 200，监听确认为 `0.0.0.0:3000`。公网域名保留规则通过构造测试。
- 资源检查：探测 socket 与超时定时器在成功 / 错误 / 超时 / 取消时关闭，abort 监听移除；context 启动失败与 shutdown 也取消探测。临时暂存 patch 已删除；开发服务重启后保持运行。
- 没测：未操作浏览器验证复制按钮，未用第二台设备测试局域网访问；没有 macOS 真机，未重建安装包。无 GPU 推理测试。
- 工作区：运行库 / 设备审查修正同时在进行，本轮只暂存地址相关文件和 context 中自己的 hunks，保留其他改动。
- 剩余：本次修正无。下一步沿用阶段 8 的原审查流程，再进入 8-4（Sonnet 5.5）；不在本轮继续。

---

## 2026-10-03 · API 模型列表修正 · Codex
- 完成：按用户确认修改决定 7 与请求路由规则。`GET /v1/models` 隐藏内置 `名字:默认`，保留基础名与用户自建方案；基础名仍使用当前方案，旧的显式默认方案调用及模型详情查询仍有效。`DEFAULT_PROFILE` 统一放在 config，models-admin 保留导出。
- 验证：先跑回归测试复现重复条目（4 fail）；修复后专项测试 6 pass。首次全量测试发现模型详情接口依赖发现列表（830 pass / 1 fail / 51 skip），改为按实际路由校验；最终 `bun test` 831 pass / 0 fail / 51 skip，`bun run typecheck` 通过，`git diff --check` 通过。真实开发服务 `GET /v1/models` 返回 200，只有三个基础名；新增方案的列表变化用隔离假数据经 HTTP 验证，无模型加载。
- 运行状态：开发热更新触发数据目录锁错误，已重启开发服务并恢复 3000 端口；重启后的开发服务保留运行，模型下次请求时加载。未修改实际模型配置。HMR 数据锁问题未在本轮扩展修复。
- 没测：安装版 / 构建产物未重建、未验证；51 项跳过保持现有平台测试条件。
- 剩余：本次修正无。工作区另有 `docs/reviews/stage-8-codex.md`，本轮未修改或提交。
- 下一步：阶段 8 的原审查流程，之后 8-4（Sonnet 5.5）；本轮不进入后续工作包。

---

## 2026-10-03 · 工作包 8-3 · Opus 5.5
- 完成：plan 8-3 四项打勾。`server/core/devices.ts`（解析 `--list-devices`、按可执行文件缓存 60 秒的 `DeviceProbe`、失败回落 nvidia-smi 序号、`deviceMissing`、`describeDevices`）；`GET /api/devices`（`?runtime=` `?refresh=1`；Mac 返回 `{ applicable: false }`）、`POST /api/models/:id/device`；`device` 字段在方案 / 模型 / 全局默认（`defaults.device` / `defaultsCpu.device`，按最终运行库类型取）三层，`auto` 是显式自动；`planLaunch` / `previewLaunch` 带 `device`；启动前对照设备列表，缺失抛 `device-missing`（不起进程、不换设备），进程里的 `invalid device:` 也识别成同一类；CPU 三个参数键 `threads` / `numa` / `cpuMask`（保存时校验）；额外参数警告 `extra-overrides-device`、`extra-multi-device`。中文文案在 `i18n/zh-CN.ts`。
- 验证：`bun test` 全部通过（新增 `devices.test.ts`、`device-launch.test.ts`）；`bun run typecheck` 通过。真机（用户同意；RTX 5090，b11146，Qwen3.8-27B Q4 17 GB，临时数据目录）：`--list-devices` 0.23 秒、stdout 为 `CUDA0: 名称 (总 MiB, 空闲 MiB free)`；`--device CUDA7` / `CUDA0,CUDA1` 退出码 1、`invalid device: …`；`--device CUDA0 --split-mode none` 显存 +17.3 GB；`--device none` 显存不变（连 `-ngl 999` 也不占），6 秒就绪；`-t 8 --numa distribute --cpu-mask ff` 正常，`--numa bogus` / `--cpu-mask zz` 退出码 1。再用真实 context 走了一遍：CUDA7 → 4 毫秒内 `device-missing`、没有进程；CUDA0 → 启动、显存 4.8 → 22.5 GB、停止后回落到 4.7 GB、无 llama-server 残留；全程用 junction 指向真实运行库，已用 `rmdir` 移除，真实目录完好。
- 没测：多卡（只有一张卡）：`--device CUDA1` 的真实行为、`--split-mode none` 在多卡上是否确实只用所选卡、`--main-gpu` 是否按过滤后序号（所以只传 `--device` + `--split-mode none`，不传 `--main-gpu`；8-7 要在多卡上核对）；多路 CPU / 多 NUMA（只有构造数据）；经 HTTP 的 `/api/devices`、`/device`（只测了底层与 context）；界面（8-5）；Mac（`hasDeviceSelection` 只用构造平台测）。
- 决定 / 坑：① 全局默认 device 放进 `LaunchDefaults`（可选字段，无迁移），GPU / CPU 两份各管各的运行库类型，所以「CPU 运行库 + 全局选了 CUDA0」不会发生。② CPU = `--device none` + `-ngl 0`（表单里的层数被覆盖）；额外参数里写的 `-ngl` 仍以额外参数为准。③ 显式 `auto` 能盖掉下一层选的卡；空 = 继承。④ nvidia-smi 回落只用于显示，不会据此拒绝启动（CUDA 序号可能与 nvidia-smi 不同）。⑤ `extra-multi-device` 的文案写「目前只支持一个设备」，8-7 做多 GPU 时要改。⑥ `device-invalid` 在 Mac 上拒绝任何非空值（含 `auto`）。⑦ 命令预览的 `PARAM_FIELDS`（界面表单）没加 threads / numa / cpuMask，8-5 加；i18n 里已有标签。
- 剩余：无（8-3 范围内）。
- 下一步：8-1 至 8-3 审查（gpt-6.1sol，指南 #p8-review，用「阶段审查」提示词，范围限定在 8-1 至 8-3），然后 8-4（Sonnet 5.5）。

---

## 2026-10-03 · 工作包 8-2 · Sonnet 5.5
- 完成：plan 8-2 四项打勾。`server/core/cuda.ts`（驱动 ↔ CUDA 对照、算力下限、`pickCuda` 自动选取）、`system.ts`（检测：Windows 用 nvidia-smi + 一次 PowerShell 探测 CPU / AVX / NUMA / 显卡名；Mac 用 sysctl / sw_vers；解析、警告、`memoryFit` 都是纯函数，命令经 `RunCmd` 注入，带超时，失败 = unknown 不猜）、`GET /api/system`（`?refresh=1` 重测，缓存 60 秒）。settings v6：`defaultsCpu`、`llamacpp.currentCpu`；`defaultsFor` / `currentTagFor` 按最终运行库类型取默认参数与当前版本（只在 Windows 有 CPU 通道，Mac 一份）；`launch.ts` 的 `RuntimeUse` 多了 `accel`；`RuntimeManager` 每个通道各有当前版本（`useCurrent`、删除时落到本通道最新官方版）；`Updater` 支持 `cudaLimits` 和 `run({force})`；context 里另一通道（CUDA↔CPU）有自己的 updater（`ctx.secondary`），启动时只在该通道已装有版本时才自动更新；接口 `POST /api/llamacpp/download`（首次下载另一通道）、`POST current` 多 `channel` 参数、GET `llamacpp` 多 `secondary`、`/api/settings` 多 `defaultsCpu` / `builtinDefaultsCpu`（Mac 不返回，保存 `defaultsCpu` 在 Mac 上拒绝）。警告文案在 `i18n/zh-CN.ts` 的 `system.warnings`（界面 8-5 接）。
- 验证：`bun test` 833 pass / 0 fail（新增 54 个：`system.test.ts`、`channels.test.ts`）；`bun run typecheck` 通过。真机只读检测（本机 RTX 5090、驱动 617.14）2.1 秒，不加载模型、不占 GPU：driver / banner CUDA 13.4 / 算力 12.0 / 32607 MiB / Ryzen 12 核 24 线程 / AVX512 / NUMA 1，无警告。用 `bun` 脚本在临时数据目录起真实 context（autoUpdate 关）：v5 settings 被迁移成 v6（`cudaRuntime: 13.3` 保留），`getSystem()`、`secondary`（cpu）、列表都正常；已清理。
- 没测：经 HTTP 的新接口（`/api/system`、`download`、`current` 的 channel）只测了底层函数；真实下载 CPU 版 / 自动选取 12.x（只用假 Release）；Mac 全部走构造的 sysctl 输出，没有 macOS runner / 真机；多路 CPU 的 NUMA / 插槽只用构造数据；界面未做（8-5）。
- 决定 / 坑：① 驱动对照来自 NVIDIA 官方发布说明（13.x ≥580、12.x ≥525、11.x ≥450；CUDA 13 起不支持算力 <7.5，12 起 ≥5.0）。较新驱动的 nvidia-smi 横幅写「CUDA UMD Version」，旧的写「CUDA Version」，两种都解析。② `cudaRuntime`：用户决定走自动（2026-10-03），迁移 5→6 把旧默认值 `13.3` 清成空 = 自动；其他手填的值保留为覆盖。③ 硬件未知时自动选「最低主版本里最新的」（12.x），不往上猜；一个都跑不了抛 `no-compatible-cuda`（detail 里有每个版本的原因），不静默降级。④ Windows 没有 FMA / F16C 的探测接口，这两项是 null（未知）；Apple 芯片的 x86 指令集也是 null，所以 `no-avx2` 警告只对 x86 报。⑤ AMD / Intel 显卡的提示只在没有 NVIDIA 时出现（有 N 卡时核显是噪音）。⑥ 模型编辑抽屉里「继承」显示的默认值用主通道的那份（表单还不知道方案会选哪个运行库），8-5 可改进。⑦ `memoryFit` 写好并测了但还没接入（9 阶段显存 / 内存检查用）。
- 剩余：无（8-2 范围内）。
- 下一步：8-3（Opus 5.5，指南 #p8-3）。实测前先告诉用户（会用真实 llama-server 占 GPU）。

---

## 2026-10-03 · 工作包 8-1 · Sonnet 5.5
- 完成：plan 8-1 五项打勾。`server/core/runtimes.ts`（引用串 `cuda:b123` / `cpu:` / `metal:` / `custom:<id>`、`runtimes.json` 登记含损坏恢复、PE / Mach-O / ELF 文件头识别、`resolveRuntimeRef` 与兜底、`refOfExe`）、`runtime-add.ts`（目录 / 压缩包 / GitHub 三种来源：先暂存预览再确认）、`runtime-manager.ts`（列表、删除保护、`protectedTags`）；`launch.ts` 按 方案 ← 模型 ← 全局 解析并在 plan / preview 里带 `runtime`；`models-admin` 加 `runtime` 字段校验（只能选本机平台的版本）；`Updater` 自动清理的保护集加入被选中的版本；兜底时写 `runtime-fallback` 事件（总览「最近事件」和日志事件页能看到）。接口：`/api/llamacpp/add/{preview,confirm,cancel}`、`delete-plan`、`DELETE /api/llamacpp/:ref?confirm=1`、`POST /api/models/:id/runtime`，GET 多返回 `runtimes`。
- 验证：`bun test` 779 pass / 0 fail（新增约 76 个）；`bun run typecheck` 通过（故意写错确认它真的在检查）。真机：用本机已装的 b11146 目录跑了一次真实「目录 → 暂存 → 运行真实 `--version` → 登记」（4.5 秒、740 MB、识别为 CUDA / b11146），Mac 目标识别不到 `llama-server` 而拒绝；临时数据目录，已清理。
- 没测：真实 GitHub Release 下载（只有假 fetch）；macOS（Mach-O 头、`.tar.gz` 在 Mac 上的解压、quarantine / 可执行权限用注入函数测，真实行为留给 8-6 的 macOS runner）；从界面走一遍（8-5 才做界面）；`custom/` 里的真实进程被残留清理（用注入的进程表测）。
- 决定 / 坑：① `--version` 在**预览**阶段就会运行所选程序，8-5 的界面必须在调用预览前先弹「这会运行你选的程序」。② 同一时刻只暂存一个预览，新预览替换旧的，30 分钟过期，启动时清 `.stage-*` / `.del-*`。③ GitHub 来源只认 `https://github.com/`（含资产下载地址），Windows 取 CUDA（有 cudart 就一起装）或 CPU，Mac 只认与本机架构一致的资产；没有公布 SHA-256 时预览返回算出的值，确认要 `acceptUnverified: true`。④ 删除是同步的（改名 → 改模型引用 / 登记 / 当前版本 → 删目录），中途失败会把目录改回去。⑤ 全局「当前版本」仍是 `settings.llamacpp.current`（只管 `acceleration` 选中的那个通道）；`POST current` 的通道参数和 `currentCpu` 留给 8-2。⑥ 全局没有引用时的行为完全没变（旧测试没改）。⑦ 兜底只针对**有引用**的情况；全局 current 缺失仍走原来的 `no-runtime` 前置条件。
- 剩余：无（8-1 范围内）。`/api/llamacpp` 的界面、兜底提示条在 8-5。
- 下一步：8-2（Opus 5.5，指南 #p8-2）。

---

## 2026-10-03 · llama.cpp 多 GPU 调研 · Codex
- 完成：只调研并新增 `docs/research/multi-gpu.md`；梳理官方多 GPU 参数、当前主线 `tensor` 实验限制、CUDA Release 及与阶段 8/9 的接入关系。未改代码或 `plan.html`。
- 验证：本机 `llama-server --version` = `0.5.0-dev` build 11146 / commit `7fe450e19`；`--list-devices` 只列出 1 张 RTX 5090（32579 MiB 总量、30991 MiB 空闲），没有加载模型；浏览官方文档和 Release，并引用一份公开 V100 实测。未跑测试；没有多卡性能实测。
- 剩余：等用户审阅是否扩展阶段 8 决定 39、增加多 GPU 工作包，以及四个产品决策（详见研究文档）。
- 决定 / 坑：`--tensor-split` 顺序受 `--device` 顺序影响；多 GPU 需按设备逐卡估算显存；官方当前 `tensor` 模式有架构、Flash Attention、KV cache 和 `--fit` 限制。
- 下一步：由用户决定是否纳入阶段 8；本次按用户要求未提交。

---

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

## 2026-10-03 · 多 GPU 决定写入计划 · Sonnet 5.5
- 完成：用户看完 `docs/research/multi-gpu.md` 后定了四点（默认单卡且为显存最大的一张、可多选至少一张、多选自动多卡；切分模式全开放，`tensor` / `row` 启用前验证；全局 / 模型 / 方案三层都有但默认单卡、需打开才显示多选；显存估算按实际启用的卡逐卡算），已写成 plan 关键决定 45、阶段 8 新增 8-7、决定 39 / 43 加指向、阶段 9 依赖 8-7、指南 8-7 卡片；阶段 9 的待确认项也定了（上限 1–99、放不下不提供强行启动）。阶段 7 关口用户说不用试用，视为通过。
- 验证：只改文档，没改代码，没跑测试。
- 剩余：8-1 起都没开始；阶段 8 关口现在在 8-7 之后。
- 下一步：8-1（Opus 5.5，指南 #p8-1）。

---

## 2026-10-03 · 工作包 7-2 · Sonnet 5.5
- 完成：plan 7-2 三项打勾。向导「选择方式」新增第三项「没有域名，用临时地址」（只在首次设置里出现；选它后步骤是 端口 → key → 选择方式 → 连接，连接时写入 `tunnelMode: 'quick'`，其他方式写回 token；连接页明说临时地址的限制）。总览显示隧道方式；「高级」里可在「自有域名 / 临时地址」切换、选隧道协议（HTTP/2 推荐 / QUIC 备用）；临时模式隐藏「再加一个地址」和隧道 token；状态文案不提 token。地址列表（`PublicAddresses.vue`、总览公网小卡）和服务端用同一规则：`publicAddresses` 拆到 `server/core/public-addresses.ts`（`public-check.ts` 仍重导出，测试不用改）。README 新增「方式 C」，README / `docs/windows-desktop.md` 写明卸载清理。文案全在 `i18n/zh-CN.ts`。
- 验证：`bun test` 703 pass / 0 fail；`vue-tsc -b --noEmit` 无输出（`bun run typecheck` 在本机被 GameGuard 弄崩，沿用 7-1 的做法）。源码版（`nuxt dev`，临时数据）在浏览器面板走了向导：选第三项 → 4 步 → 连接，`settings.public.tunnelMode` 变 quick、限制说明显示、完成后总览「高级」有方式 / 协议、无 token 区、无「再加一个地址」。真机冒烟（用户同意；独立目录构建、临时数据、没碰仓库 `.output` / `data/` / `~/.cloudflared`，已清理）：本机已装 cloudflared 被复制到 `runtime/cloudflared/win32-x64/`，临时隧道连通；经 `*.trycloudflare.com` → llama-web 公网入口（:18080）→ 假 llama-server：无 key 401、错 key 401、带 key 访问 `/api/settings` 和 `/` 都 404、`/v1/models` 200、非流式 200、流式 31 个事件分 31 次读到（首条 34 ms）；自检返回 401（ok）。关闭托管后 cloudflared 退出、`pids.json` 只剩模型进程；切 QUIC 重启后地址换了新的；关闭公网访问后无 cloudflared；强杀 llama-web 后无 cloudflared / llama-server 残留；数据目录里 cloudflared 相关只有 `quick-tunnel.yml` 和 exe。
- 没测：从零下载 cloudflared（本机有已装的，只走了「复制」；下载路径只有单元测试）；用真实 llama-server（用户同意的是真实，我改用假的以免占 GPU，直连真实 llama-server 的流式 7-1 已测）；桌面安装包里的新界面；窄屏 / 深色下新向导选项的样式；总览公网小卡在临时模式下的实际显示（只看了代码）；某次开关后 8 秒内没见到 cloudflared 进程，之后重复十几次都在 3–4 秒内起来，没复现。
- 决定 / 坑：临时模式的向导选项只在首次设置里给（「再加一个地址」对临时隧道没有意义）。工作区里原有的未提交改动（首次使用引导、阶段 8 规划文档）一并进了这次提交，因为 `i18n/zh-CN.ts`、plan、handoff 是同一批文件无法拆开。Windows 下 curl 刚连通的 trycloudflare 地址可能解析不到，等几秒（DNS 传播）；自检接口是服务端请求，更稳。
- 剩余：无（7-2 范围内）。
- 下一步：阶段关口 7，等用户试用确认：开启公网访问 → 选「没有域名，用临时地址」→ 拿到地址后用客户端带 key 试聊天（含流式）→ 「高级」切模式 / 协议。确认后才进入阶段 8（先问阶段 8 开头的待确认问题）。

---

## 2026-10-03 · 阶段 8 规划（运行库、设备与用量） · Sonnet 5.5
- 完成：用户一次性提出一批需求，已写成 plan 阶段 8（8-1 至 8-6 + 审查 + Mac 专项）、关键决定 34–40、接口 / 坑位 / 变更记录，以及指南阶段 8 卡片。内容：手动添加 / 删除 llama.cpp 版本（目录 / 压缩包 / GitHub 地址）、按模型和配置方案选版本、全局默认 GPU / CPU 两份 + 本机检测、单设备选择、30 天用量日志、模型页添加目录、Mac 单独处理。
- 验证：只改了文档（plan.html、claude-guide.html、handoff.md），没改代码，没跑 `bun test` / typecheck；plan.html 在浏览器面板里打开过但没逐段看渲染。
- 用户的硬性要求：最新官方版不可删；启动时版本缺失用同通道最新官方版兜底（不改保存的配置）；Mac 与 Windows 版本互相隔离，Mac 上界面不出现任何 GPU 相关内容；尽量把 Mac 做全。
- 待用户确认（plan 阶段 8 开头）：「git 地址」按 Release 下载理解；目录添加复制进 data/runtime；用量日志做汇总；「多 CPU」含义；是否纳入 AMD / Intel；Mac 套壳 / 启动脚本是否另开包。
- 坑：阶段 7 的 7-2 和关口未完成；工作区仍有首次使用引导的未提交改动（上一条交接），本次没碰。现有 UI 里有 Mac 的 GPU 提示文案（`macHint`、`runtimeHint`），与新要求冲突，8-6 要清掉。关键决定 14「只用官方最新版」已放宽。
- 追加（同一会话）：用户要求放开单开限制、多开前做显存检测、保存设置时多方面检查、外部请求触发的多开放不下也要拦住 → 写成阶段 9（关键决定 41–44，9-1 至 9-4 + 审查，依赖 8-3 的设备选择）。会改核心行为规则（决定 9），9-3 前须用户确认规则文字；升级后上限默认仍为 1。待确认：请求触发时是否允许卸载空闲模型腾地方。
- 用户后续确认：多 CPU = 多路 CPU（很少见，按检测结果来）；暂不考虑 AMD / Intel；多开由设置开关控制（默认关），请求放不下时用户二选一「卸载上一个 / 服务端报错」；Mac 套壳另开工作包。随后用户确认：git 地址按 Release 下载、目录复制进 data/runtime、用量日志做汇总、Mac 启动脚本 start.command 放进 8-6。待办只剩阶段 7 关口与工作区未提交改动的处理。
- 剩余：8-1 起都没开始。
- 下一步：先问用户是否进入阶段 8 并确认上面的问题，然后 8-1（Opus 5.5，指南 #p8-1）。

---

## 2026-10-03 · 首次使用引导（用户追加，非编号工作包） · Sonnet 5.5
- 完成：审查首次使用全流程，发现三处缺口并补上（plan 关键决定 33，阶段 7 下新增一节两项，已打勾）：① 旧向导只有一个路径输入框，且混着作者自用的 llama-swap 导入；② 从扫描启用模型后 mmproj / MTP 永远是 null，用户得自己进编辑抽屉；③ 第一次点启动没有任何确认。现在：向导三步说明 + 多目录 +「选择文件夹…」（`server/core/folder-picker.ts`，PowerShell `FolderBrowserDialog`，`POST /api/fs/pick-folder` 只认 localhost / 127.x / [::1] 的 Host）+ 粘贴路径；`ModelConfig.confirmed`（planEnable 写 false，缺省 = 已确认）→ `needsSetup` → `ModelCard` 启动前弹 `FirstStartDialog`（思考开/关、视觉、MTP + 倍数，同目录候选文件），`POST /api/models/:id/setup` 调 `applyFirstSetup` 写进当前方案并启动。
- 验证：`bun test` 700 pass / 0 fail（新增 `tests/core/first-setup.test.ts`）；`nuxt prepare` 后 `vue-tsc -b --noEmit` 无错误。源码版（`nuxt dev`，临时数据目录 + 假 llama-server + 假 gguf：模型 / mmproj / MTP 各一个）在浏览器面板走了一遍：自动进向导 → 粘贴路径添加并扫描（找到 1 个）→ 完成进入扫描发现 → 启用 → 启动弹框（视觉、MTP 已选上，倍数 3）→ 确认后 models.json 里 mmproj / draft / `reasoning on, reasoningBudget -1` / `--spec-type draft-mtp --spec-draft-n-max 3` 都对，模型进入运行中；`/api/fs/pick-folder` 带非本机 Host 返回 403。临时进程和 `.cache/8-1` 已清理。
- 没测：「选择文件夹…」的原生窗口（真实弹出、取消、中文路径）没点过；浅 / 深色、窄屏下的向导和确认框没看；桌面安装包没重新构建；思考「关」和 MTP 对真实 llama-server 的实际效果没验证（只验证了写入的参数）；深色和 mmproj 多候选时的下拉没看。
- 决定 / 坑：拖拽目录不做（浏览器拿不到完整路径，用户选了「只做选择按钮 + 粘贴」）。思考「开」写 `--reasoning-budget -1`（llama.cpp 里 -1 才是不限，0 是关闭，和用户口述的「0 不限制」不一致，已在决定 33 注明）。是否自带 MTP 没法从 GGUF 判断，所以没有同目录 MTP 文件时开关照样可开，由用户决定。工作区里 `server/core/tunnel.ts`、`tests/core/tunnel.test.ts`、`docs/reviews/stage-7-codex.md` 的改动不是这次做的（会话开始时工作区是干净的，审查会话产生），没碰，也没有提交本次改动。
- 剩余：无（上面「没测」的项请试用时看）。
- 下一步：7-1 审查的意见处理，然后 7-2。

---

## 2026-10-03 · 阶段 7 审查意见处理 · Opus 5.5
- 完成：`docs/reviews/stage-7-codex.md` 三条都已标注。S7-001 已修复：新增 `cloudflaredEnv()`，两种模式都去掉继承的全部 `TUNNEL_*`（大小写不敏感），token 模式只写回保存的 token。S7-002 已修复：`quickTunnelHost` 只按日志前缀级别和 `error=` 字段判断错误行，地址里的 error / err / wrn 单词不再误判。S7-003：计划文字澄清（只有临时模式换端口重启，token 模式行为不变），并修复 token 模式换端口后 hostnames 仍按旧端口筛选的问题（记住最近一次配置行，按新端口重新筛选）。
- 验证：`bun test` 703 pass / 0 fail；`bun run typecheck` 退出 0。两项都在包含另一会话未提交改动（首次启动 / 目录选择相关）的工作区里跑的；这些改动没提交、没碰。没有真实隧道验证。
- 剩余：无（审查范围内）。审查报告里建议的完整链路验收（quick 隧道 → :8080 → proxy，401 / 404 / 流式 / 断开）放在 7-2 真机冒烟。
- 决定 / 坑：剥离全部 `TUNNEL_*` 也作用于 token 模式（以前只删 TUNNEL_TOKEN），环境变量不再是 cloudflared 的隐式输入。
- 下一步：7-2（Sonnet 5.5，提示词在指南 #p7-2）。

---

## 2026-10-03 · 工作包 7-1 · Opus 5.5
- 完成：plan 7-1 四项打勾，另加一项（用户会话中追加，关键决定 32）也已完成。`public.tunnelMode`（token / quick）和 `public.tunnelProtocol`（http2 默认 / quic），settings v5 迁移（旧配置 → token + http2）、normalize 回落、`applyPublic` 校验、`cleanWizard` 接受 `path: 'quick'`、一键完成写回 token。`TunnelManager`：`Launch`（模式 / token / 端口 / 协议）决定是否重启；临时模式不要 token、环境里删掉 TUNNEL_TOKEN；参数 `tunnel --no-autoupdate --protocol <p> --config data/runtime/cloudflared/quick-tunnel.yml --url http://127.0.0.1:端口`；`TunnelInfo` 新增 `mode`、`quickHost`（启动、重启、进程退出、停止时都清空）。`publicAddresses(pub, tunnel)` 和 `/api/public/check` 在临时模式下只用 `quickHost`。用户确认阶段 6 关口的方式：直接发起了 7-1。
- 验证：`bun test` 693 pass / 0 fail；类型检查 `node node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit` 通过（**`bun run typecheck` 被 GameGuard 弄崩**，本机开着 GameMon；用故意写错的文件确认过 vue-tsc 确实在检查）。实测（用户同意，临时目录，没碰仓库 data/ 和 ~/.cloudflared，cloudflared 2026.5.0）：① 临时 HOME 里放带 tunnel + ingress 的 config.yml：不带 `--config` 时隧道照样连上，但 `GET /` 返回 **404**（被那份 ingress 接管）；带上我们的 `--config` 后返回 502（路由到了空端口 9，正确）→ `--config` 是必要的，已写进决定 31。② 用 TunnelManager 临时模式 + 真实 llama-server（只绑 127.0.0.1，随机 --api-key，一个已配置模型，200 token）跑 HTTP/2、QUIC 各一次：都是不带 key 返回 401、非流式 200、流式 200 个事件分 198 / 199 次读到，首条 0.18 / 0.13 秒（本机直连 0.11 秒）→ 流式正常，和决定 31 一致；cloudflared 的 Registered 行确认 protocol=http2 / quic；关闭后 cloudflared 进程退出、pids.json 为空，没有残留进程。
- 没测：经 llama-web 公网入口（:8080）的完整链路，这次直连 llama-server 的 --api-key（入口代码没改）；从零下载 cloudflared（这次复用本机已装的）。这两项都放在 7-2 的真机冒烟里。
- 剩余：无（7-1 范围内）。界面全部留给 7-2：`PublicAddresses.vue` 和 `pages/index.vue` 目前还直接用 `domain` + `hostnames`，临时模式要改用 `quickHost`（plan 7-2 已写）；协议选择界面也在 7-2。
- 坑：`shutdown()` 后 status 仍停在 connected（原有行为，只在退出时调用，没改）。Windows 下 env 键名大小写不同的 `tunnel_token` 不会被删除（极少见）。
- 下一步：7-1 审查（gpt-6.1sol，指南「阶段审查」提示词，范围限定在 7-1 的改动），然后 7-2（Sonnet 5.5）。

---

## 2026-10-03 · 阶段 7 规划（免域名临时隧道） · Sonnet 5.5
- 完成：用户要求公网向导新增「没有域名，用 Cloudflare 临时隧道」，cloudflared 本地解决、卸载清理干净。新增关键决定 31、plan 阶段 7（7-1、审查、7-2）、指南阶段 7 卡片（含各包推荐模型：7-1 Opus 5.5、审查 gpt-6.1sol、7-2 Sonnet 5.5）。
- 验证：只改了文档（plan.html、claude-guide.html、handoff.md），没改代码，没跑 `bun test` / typecheck。
- 剩余：7-1、7-2 都没开始。
- 决定 / 坑：现有 `server/core/tunnel.ts` 已经会把 cloudflared 复制或下载到 `data/runtime/cloudflared/`，临时模式直接复用。方案草稿：`public.tunnelMode`（settings v5）、`TunnelManager` 的 `--url` 模式、地址取自输出里的 `*.trycloudflare.com`。**评估性实测（临时脚本，已清理，cloudflared 2026.5.0，假 SSE 服务每秒一个事件）：GET 被缓冲（8.7 秒后一次性到达），POST 逐条到达（首条 1.0 秒）。LLM 流式是 POST，所以值得做；还没用真实 llama-server 测，7-1 复测。** `~/.cloudflared/config.yml` 可能影响临时隧道，也要实测。阶段 6 关口还没得到用户确认，7-1 开始前先问用户。
- 下一步：7-1（Opus 5.5，提示词在指南 #p7-1）。

---

## 2026-10-03 · 发布 v0.1.0-beta.2 · Sonnet 5.5
- 完成：应用户要求发布 v0.1.0-beta.2（prerelease，tag → 273945a）。版本号我定的（用户没指定）：package.json、Cargo.toml、Cargo.lock 各改一行，写了 `docs/release-notes/v0.1.0-beta.2.md`，手动触发草稿 workflow，CI 全部步骤通过。
- 验证：从草稿下载安装包，SHA256 与 SHA256SUMS 一致，`bun desktop/check-package.ts` 通过（338 个文件），确认后 `gh release edit --draft=false`。没有安装运行安装包，没测 beta.1 → beta.2 的应用内升级，没有在干净机 / 无 NVIDIA 机器上试用；发布说明里已写明。
- 剩余：安装版里的新界面逐页试用、应用内升级实测（可借这次真实的两个公开版本做）。
- 下一步：无。

---

## 2026-10-03 · 工作包 6-2 · Sonnet 5.5
- 完成：plan 6-2 三项打勾。模型页：已启用改为列表行（`ModelCard`，状态胶囊 `StatusPill`、量化 / 视觉 / 草稿标签、方案下拉、编辑图标、启动 / 停止 / 重试，加载进度条和失败卡在行内）、扫描发现改卡片网格（`DiscoverPanel`）、新增筛选框与分段切换；编辑抽屉改文件 / 配置方案 / 参数三栏（`ModelEditor`，逻辑不变，所有 ProfileForm 仍保持挂载，命令预览与重复参数警告还在参数栏里）。日志页：一行工具栏，模型输出终端风格（按行文本判断 err / warn / eval 着色），事件时间线，请求表格。设置页：左侧分区目录（滚动跟随高亮）+ 分区卡片，llama.cpp 版本改单选行。`AppCard` / `PageHeader` 改成新样式（向导和设置、导入、公网向导都用它们），公网向导里的小方框圆角统一 10px。删除 `StateDot` / `StateBadge`。文案新增在 `i18n/zh-CN.ts`（models.filter、models.edit.tabs / paramsFor、logs.view、settings.toc）。
- 与交互稿差异（数据里没有或会新增功能的没做，已写进变更记录）：模型行没有大小 / 上下文标签（实时数据没有；量化取文件名）；日志页没有「下载」按钮（没有接口，没新增）；日志的「时间范围」仍是原来的「实时 / 文件」选择。
- 验证：`bun test` 675 pass / 0 fail，`bun run typecheck` 通过（改完后各跑了一次）。源码版（`bun run dev`，临时数据目录 + 假 llama-server）在浏览器面板看了：模型页启动 / 运行中、编辑抽屉三栏、扫描发现卡片、日志（模型输出 / 请求）、设置页（深色，目录跳转），深浅色切换，390 宽下四个页面 + 向导无横向溢出（只用脚本量了 scrollWidth，模型页窄屏截图看过；日志 / 设置窄屏、事件标签页、加载中 / 失败行、首次向导、公网向导和各对话框的新样式**没有逐一截图看**）。**桌面安装包没有重新构建验证**，验收标准里的「桌面安装包实际打开看过、断网字体」本轮没做，用户试用时请用 `start.bat build` 或 `bun run desktop:build` 看。
- 坑：`bun run dev` 会按 `LLAMA_WEB_DATA` 指定的目录初始化；目录里没有 settings 时会触发 llama.cpp 自动下载（约 700 MB），要先用 `.cache/6-1/setup.ts` 那种方式播种配置（autoUpdate 关）。本轮第一次启动就踩了：数据目录是 `.cache/` 下的临时目录，没碰仓库 `data/`，已删。
- 剩余：阶段关口 6，等用户试用确认；上面「没有逐一截图」的页面请重点看。
- 下一步：无（阶段 6 到此）。用户确认后才有新工作。

---

## 2026-10-03 · 工作包 6-1 · Opus 5.5
- 完成：plan 6-1 三项打勾。设计变量（main.css，浅 / 深两套映射到 Nuxt UI 变量，primary indigo / neutral gray）、本地 Geist 字体（新依赖 `@fontsource-variable/geist`、`geist-mono`，用户同意；`ui.fonts: false` 关掉 @nuxt/fonts）、左侧栏 `AppSidebar`（≥820px 侧栏固定、只有 `.lw-main` 滚动；窄屏侧栏在上、导航横排）、总览 `pages/index.vue` + `OverviewHero`。新组件用 `lw-*` 类（`lw-card` / `lw-chip` / `lw-st-*` / `lw-seg` / `lw-bar` / `lw-tbl`），6-2 沿用。纯逻辑在 `app/utils/overview.ts`（有测试），速度曲线由 `useSpeedTrend`（布局里启动，每秒从 useLive 采样）。日志页支持 `?tab=events|requests`。
- 与交互稿差异（数据里没有的不显示，已写进变更记录）：最近请求的「速度」列改「耗时」；llama.cpp 小卡无 CUDA 标签；无 nvidia-smi 时显存卡隐藏；更新提示条只留「查看更新」+ 本次关闭；ctx 取命令预览接口（实例变化时取一次），量化取文件名。
- 验证：`bun test` 675 pass / 0 fail，`bun run typecheck` 通过（收尾时开着带 GameGuard 反作弊的游戏，Bun 启动子进程会崩溃，关掉后重跑通过）。源码版（独立 worktree 构建，端口 5091，临时数据 + 假 llama-server）在浏览器面板看了浅 / 深 / 1280×600 / 390 宽：运行中（实时 t/s、曲线）、加载中进度、加载失败卡、空状态、断线横幅、模型 / 设置页在新骨架下可用，桌面宽度整页不滚动、侧栏不动、无外部请求、字体为本地 Geist。桌面版：`bun run desktop:build` 出的 0.1.0-beta.1 本地包装到测试目录，经 WebView2 调试端口截图浅 / 深 / 窄屏（`.cache/6-1/shots/`），本地字体、无外部请求、剪贴板可用、关窗进程退出、卸载 0。断网启动没有单独测（字体全在包内、页面没有外部请求）。更新提示条新样式没有实际触发看过。
- 事故：`bun run build` 会先清空仓库 `.output`；用户自己的实例当时正从 `.output` 运行（:5001），被弄坏，用户已停掉。现在仓库 `.output` 是 a74a939 的构建（旧界面）；要用新界面需 `start.bat build`。以后测试一律在独立 worktree 构建，不碰仓库 `.output`。
- 坑：静默安装（/S）后安装包会自动启动应用（默认数据目录），再用自定义环境启动会被单实例挡掉、立即以 0 退出；测试脚本要先结束自动启动的那个（见 `.cache/6-1/desktop-check.ts`），并清理 `%LOCALAPPDATA%\io.github.llama-web.desktop`（本轮已删）。`tauri build` 又改了 Cargo.lock，已 checkout。
- 剩余：无（6-1 范围内）。旧组件（StateDot / StateBadge / PageHeader / AppCard 等）6-2 仍在用，6-2 结束时删不用的。
- 下一步：6-2（Sonnet 5.5，提示词在指南 #p6-2），完成后阶段 6 关口停下等用户试用。

---

## 2026-10-03 · 阶段 6 规划（界面重设计交互稿） · Opus 5.5
- 完成：用户觉得第一版界面是临时凑合的，做了可交互的设计稿并获确认（没有意见；要求桌面宽度下侧栏固定不滚动、只有内容区滚动）。新增关键决定 30、plan 阶段 6（6-1、6-2）、指南阶段 6 卡片；交互稿源文件存到 `docs/design/ui-v2-prototype.dc.html`。
- 验证：只改了文档，没改代码，没跑 `bun test`。交互稿没有在浏览器里截图核对过。
- 剩余：6-1、6-2 都没开始。
- 决定 / 坑：交互稿是设计画布格式（`<x-dc>` 模板 + `renderVals()`），不能直接用浏览器打开，读源码取数值即可；里面的模型名、数字、版本号、地址都是示例。端口按真实默认值 5001。字体 Geist 必须随包本地提供（桌面版可能断网），新增依赖前先问用户。
- 下一步：6-1（Opus 5.5，提示词在指南 #p6-1）。

## 2026-10-03 · 工作包 5-3（已发布） · Opus 5.5
- 完成：用户确认后发布 v0.1.0-beta.1（prerelease，tag → dba2238），plan 5-3 主任务打勾。仓库本来就是公开的，未做更改。
- 验证：匿名从公开 Release 下载，安装包与验收过的草稿逐字节一致，SHA256SUMS 通过；用 `pickUpdate` 跑真实公开 API：0.1.0-beta.0 → beta.1（安装包摘要 + SHA256SUMS 齐全），beta.1 本身无更新，正式版用户不收预发布。发布后只有文档改动，提交前 `bun test` / typecheck 重跑。
- 剩余：5-2 第二项（干净机 / 无 NVIDIA）仍未打勾；两个公开版本之间的线上升级要等下一个版本时实测。CR-013（公开历史里的真实隧道名）仍待用户决定。
- 下一步：阶段 5 关口，停下等用户试用。下一版：改 package.json（同步 Cargo.toml / Cargo.lock 那一行）、写 docs/release-notes/v<版本>.md，手动触发 workflow，从草稿下载验收后发布。不做 Mac，除非用户另行要求。

---

## 2026-10-03 · 工作包 5-3（草稿已就绪，待用户确认发布） · Opus 5.5
- 用户确认：v0.1.0-beta.1、MIT、未签名；要求现代化应用更新（新增决定 29）。用户未在干净机 / 无 NVIDIA 试用，5-2 第二项继续不打勾。
- 完成：plan 5-3「应用内更新」打勾。设置页「关于与更新」、提示条 + 更新说明对话框、跳过、桌面版下载双重校验 + 壳复核后被动安装、源码版链接发布页；LICENSE、版本单一来源；手动触发的草稿 Release workflow、包内容 allowlist 检查、发布说明 `docs/release-notes/v0.1.0-beta.1.md`。草稿 prerelease 已生成（未建 tag）。主任务未打勾：发布须用户确认。
- 验证：`bun test` 669 pass（本机），typecheck，Rust 8 pass；CI 全部步骤通过（一次 5-1 身份探测计时失败，重跑通过）。从草稿下载包：SHA256 一致、包检查通过、安装 / 四页面 / 假模型 / 关窗清理 / 卸载保留数据、应用内升级到本机 beta.2 测试包通过。详见 `docs/windows-desktop.md` 5-3 节。
- 剩余：用户确认后发布草稿（`gh release edit v0.1.0-beta.1 --draft=false`），再从公开 Release 下载复核并给 5-3 主任务打勾；真实两版本间的线上升级、干净机 / 无 NVIDIA 未验。CR-013 历史仍待用户决定。
- 决定 / 坑：NSIS 语言选择框会卡住被动安装，已关闭。cargo test 依赖生成的 resources，CI 中放在构建后。改版本只改 package.json（Cargo.toml / Cargo.lock 的包版本同步改一行即可；tauri build 会重写 Cargo.lock，构建后 checkout 再改那一行）。基线时运行的源码版实例在测试期间停止，原因未查明（脚本未按名称 / 端口结束进程）。
- 清理：测试安装、数据、应用本地目录已删；`.cache/5-3`（脚本、日志、截图、草稿下载、本机 beta.1 / beta.2 测试包）有意保留。
- 下一步：等用户审阅草稿并确认发布；阶段 5 关口后停下。不做 Mac。

---

## 2026-10-02 · 工作包 5-2（第三次接续，本机验收完成） · Opus 5.5
- 完成：plan 5-2 第一项（Tauri 验证与薄壳）打勾。第二项本机部分全部通过，但缺干净 Windows / 无 NVIDIA，不打勾。修复：端口冲突经私有管道报原因码，启动页显示中文原因（原来只有 `Service exited`）；运行缓存从 `data/run/desktop` 移到应用本地数据目录的 `rc`（深数据目录使 sharp DLL 超出 LoadLibrary 路径上限，服务起不来）；首次下载失败提示重新打开会重试；测试包版本 0.0.1。
- 验证：`bun test` 653 pass / 0 fail，`bun run typecheck`，Rust 5 pass，`cargo fmt --check`。安装版窗口经 WebView2 调试端口（只对测试壳设环境变量）+ WM_CLOSE + 窗口消息填文件夹对话框：四页面中文 / 深浅色、窗口内 SSE 与 12 秒静默流式、HTTP 页面原生命令全被 ACL 拒绝、端口冲突重试 / 退出、导入对话框、从备份恢复、209 字符数据目录 + sharp 缩图、断网启动（测试壳设不可达代理）。真机：b11146 CUDA 下载中 / 解压中关窗、27B 模型 GPU 加载中关窗（显存回基线）后重开加载流式；0.0.0 → 0.0.1 升级、强杀安装后回装 0.0.0、再升级、卸载，数据字节不变。结果详见 `docs/windows-desktop.md` 第三次接续。
- 剩余：干净 Windows（无开发工具 / 无 WebView2 bootstrapper 实测）、无 NVIDIA 的 CPU 路径与旧 CPU 指令集下限——本机无 Windows Sandbox，需用户试用。中断安装时写到哪些文件未逐一核对。gui-1 有一次无输出超时，重跑通过，原因未查。
- 决定 / 坑：`tauri build` 会重写 `src-tauri/Cargo.lock` 并去掉 `pre-commit:allow` 注释，构建后 `git checkout src-tauri/Cargo.lock`（改包版本时只改那一行）。`desktop:build` 从 HEAD 的 worktree 构建 Nuxt，服务端改动要先提交。Windows PowerShell 5 读无 BOM 的 .ps1 会乱码中文。文件夹对话框底部控件在 UIA 中只是 Pane，用 WM_SETTEXT / BM_CLICK。导航拒绝测试会把外链交给系统浏览器。
- 包：`dist/desktop/llama-web_0.0.1_x64-5-2-setup.exe`（未签名、未发布），SHA256 在桌面记录。
- 清理：上两轮残留目录已删；本轮测试安装 / 数据 / 应用本地目录（EBWebView、rc）已删，无遗留进程。`.cache/gui-*` 脚本、截图、日志和本地包有意保留。
- 下一步：Windows 套壳试用关口——用户安装试用并确认后，另开会话执行 5-3（Opus 5.5）。不做 Release / Mac。

---

## 2026-10-02 · 工作包 5-2（接续，仍部分完成） · Codex
- 完成：旧 data 导入 v2 阶段标记、完整备份摘要、可重复恢复、旧标记兼容、中文恢复入口；跨系统模型路径 / linked run / backup 拒绝。只读安装资源改用短运行缓存原子复制（完整摘要认领、异常暂存清理），未换技术栈 / 配置结构 / 调度规则；plan 两项继续未勾选。
- 验证：标准 `bun test` 652 pass / 0 fail（43 文件，无 skip）；`bun run typecheck`、`cargo check --locked` 通过，Rust 4 pass；`bun run desktop:build` 和后续 `bun x tauri build --bundles nsis` 通过。导入 11 项含真实强杀复制进程后恢复 / 恢复再次中断 / 篡改拒绝。
- 安装：最终包中文空格目录、PATH 无开发工具时内置 Bun、四页面 HTTP 200、动态 SSE、假上游静默 12 秒、假模型切换 / 回退、加载中强杀 / 重开、前后同为 0.0.0 的本地构建覆盖 / 回装及卸载保留构造配置 / key / 模型引用通过。未知 HTTP 200 占端口不被认领，释放后 private ready / shutdown 通过；未点 GUI 重试。
- 真机：最终候选包两个真实文本 GGUF 的 NVIDIA 加载 / 流式 / 切换、官方 b11140 CUDA 下载校验 / 解压后回退重载和流式通过；只读安装 ACL 下短缓存启动、官方 b11140 CPU / 0 GPU 层真实流式通过（本机仍有 NVIDIA）。真实 settings 仅只读定位路径，夹具配置自行构造，无真实 secrets / Cloudflare 读取或修改。
- 剩余：WebView 可见页面 / 深浅色 / 窗口内长请求与 SSE；GUI 冲突 / 重试、导入选择 / 恢复按钮；正常关窗时真实加载 / 下载 / 解压中止；无开发工具 / 无 NVIDIA 的干净环境、旧 CPU 指令集下限；不同版本号升级 / 故障安装回退、极深自定义数据路径。继续 5-2，不得进入 5-3 / Mac；建议导入恢复 / 运行缓存独立复审（未派发）。
- 决定 / 坑：Bun 1.3.14 模块加载在 write-denied ACL 上报 EPERM，普通读取成功；字节流复制到 data/run/desktop 的短摘要目录后解决。Windows 原生 sharp DLL 对过长路径失败，目录内仍核对完整摘要；缓存按包保留，导入不复制 run。NSIS `/D=` 必须为未加引号的最后参数，参数数组在 Bun 上要 windowsVerbatimArguments；静默默认卸载保留数据，GUI「删除应用数据」选项会删除默认目录。
- 包：`dist/desktop/llama-web_0.0.0_x64-5-2-setup.exe`，0.0.0、未签名、未发布；SHA256 与完整结果见 `docs/windows-desktop.md`。旧本地包留作测试回装。
- 清理：自有壳 / Bun / llama-server、安装与测试端口已收回，ACL 与本轮 NSIS 安装位置改动已恢复，临时 worktree 已清。CPU 验收脚本功能通过但收尾 rmSync 报 EACCES、退出 1；Native 递归 / 逐文件删除又被自动审批拒绝（仅 blocked by policy）。旧临时构建 / 夹具、首次安装失败夹具、CPU 残目录及探针 / 路径定位信息保留在忽略目录，不绕过审批；具体位置在 `.cache/desktop-5-2-continuation-resources.json`。未干预用户实例。
- 下一步：接续 5-2（Opus 5.5），先按剩余和桌面记录补人工窗口 / 干净机等验收。完成后交包停下等用户安装试用确认，仍不做 5-3 / Release / Mac。

---

## 2026-10-02 · 工作包 5-2（部分完成，需接续） · Codex
- 完成：Tauri 2 薄壳、固定 Bun + 完整 Nuxt 产物、stdin/stdout 私有 ready/shutdown（本次 UUID / PID）、单实例、15 秒退出与 Job Object、HTTP 页面无原生权限、导航限制、启动页重试 / 退出；显式旧 data 备份复制；本地 Windows x64 NSIS 包 0.0.0（未签名、未发布）。详细记录 `docs/windows-desktop.md`；plan 两项均未勾选。
- 用户确认：允许安装 Rust MSVC、Visual Studio C++ Build Tools / SDK 和项目 Tauri 构建依赖；工具安装完成。用户按 Escape 停止电脑操作后，不再调用窗口自动化，本轮结束。
- 验证：标准 `bun test` 643 pass / 0 fail（43 文件，无 skip）、`bun run typecheck`、`cargo check --locked`、Rust 3 项测试、隔离 Nuxt 构建 / Tauri debug / NSIS 构建通过；打包 Bun + sharp 输出 200×133 JPEG。调试壳中文首次向导、实时连接指示、重复启动只留原壳 / Bun、关主窗口后端口释放通过；NSIS 中文空格目录安装与卸载退出码 0。安装版已启动但页面未继续确认。
- 剩余：安装版页面 / 深浅色 / 长请求 / 动态 SSE、冲突 / 重试、真实模型流式 / 切换 / 回退、CPU 和无开发工具干净环境、只读资源、加载 / 下载 / 解压中关闭、强杀恢复、覆盖升级 / 回退保留数据、导入 GUI / 跨系统路径 / 中断恢复；不得声明 5-2 完成或进入 5-3。未运行 GPU、真实配置 / secrets / Cloudflare、Mac。
- 决定 / 坑：Bun 1.3.14、Rust 1.99.0、Tauri CLI 2.12.1；默认数据目录来自系统 API（固定 app identifier），绝对 LLAMA_WEB_DATA 可覆盖。首次数据目录先选择开始 / 复制旧 data；导入有完整备份和中断标记，硬杀后的恢复引导仍未完善。Bun license 文件名是 LICENSE.md；Nitro 默认 es2019 不支持 entry 顶层 await，使用同步监听 + 异步失败清理。
- 清理：自有壳 / Bun / 安装测试进程已停，测试安装已卸载，后来临时工作树全清；首次失败构建长路径目录残留（递归删除被自动审批拒绝，只返回 blocked by policy），.cache 测试夹具 / 日志也保留。未干预用户实例。dist/desktop 本地包与构建缓存保留，SHA256 在桌面记录。
- 下一步：另开会话接续 5-2，推荐 Opus 5.5；先读剩余与桌面记录，完成未测项、修正导入恢复 / 文案并安全清理本轮残留，再提交推送；完成后交包停下等用户安装试用，不做 5-3 或 Mac。

---
## 2026-10-02 · 工作包 5-1（跨平台兼容基础） · Codex
- 完成：plan 5-1 三项打勾；platform / 资产选择、zip / tar.gz / tgz 安装、可选 cudart / chmod / 摘要验证、解压取消 / 时限 / 越界检查；Windows 杀树与非 Windows 独立进程组 TERM → 有限等待 → KILL；可信实际路径 / birth / PGID 残留检查及配置加载前数据目录互斥。接口、迁移与边界见 `docs/platform-foundation.md`。
- 用户确认：settings v4 新增 `llamacpp.acceleration`（auto / cuda / cpu / metal）；旧配置迁移为 cuda，原参数 / current 保留，新配置 auto。JsonStore 备份旧 settings；PID v2 先备份 v1 原始字节，备份失败不覆盖，退出取消身份探测。新 runtime 按 OS / arch / acceleration 隔离；旧平铺 Windows CUDA 目录保留供加载 / 回退。
- 验证：命令进程 PATH 加入已安装 Git 的 bin 后，标准 `bun test` 638 pass / 0 fail（41 文件，无 skip）；`bun run typecheck` 通过。隔离 worktree 独立 `bun install --frozen-lockfile` 后 `bun run build` 通过（现有 Vue package exports 弃用告警）；没有构建或替换主目录 `.output`。
- 构建产物冒烟：临时 v3 配置、假模型 / Bun 编译假 llama-server，旧目录加载、迁移备份、CMD 预览、首页 200、/v1 转发、SSE、第二实例拒绝、硬杀父进程后子进程退出、死 owner 锁恢复通过。初次夹具漏传 profile 已修；真实发现服务内同步 PowerShell 身份探测超时，改为异步有界可取消并补 Bun.serve 回归后通过。
- 未运行：浏览器、真实模型 / GPU 推理、Mac 构建或真机（进程、sharp、Metal / CPU 均未验证）、真实 Cloudflare、大型运行库下载安装。仅只读 NVIDIA 探测，无真实配置 / secrets 读取或修改，无新依赖；没有桌面壳、安装包或 Release。Mac 分支为构造测试，不能声明 Mac 已支持。
- 决定 / 坑：改 acceleration 须重启；未知 NVIDIA 不自动猜 CUDA，可显式选择。无采样隐藏 GPU 卡片，Mac 提示在设置页，命令预览随平台 shell 变化。旧 PID 无 birth 跳过；实际路径 / 身份不明或 PID 复用时不杀。锁 owner 活着（含疑似复用）不抢；极短持有 guard / 写 owner 窗口被硬杀或锁损坏会保守拒绝，确认全部实例退出后才能人工处理。升级前退出没有锁协议的旧程序。
- 剩余：5-1 范围无；Mac 真机验收留后续。CR-009 解压生命周期已补齐；CR-007 成对写入硬杀恢复、CR-010 混合日志与 CR-013 历史仍保留，不重写历史。可另做独立复审；本地候选缺 runtime_identity，未冒充隔离复审、未派发或消耗其额度。
- 清理：本轮专用临时构建 worktree、冒烟脚本 / 数据与自有进程已清理；未干预用户已有实例。
- 下一步：另开会话执行 5-2，推荐 Opus 5.5；交付本地 Windows 测试安装包后停下等用户试用，不自动继续 5-3 或 Mac。

---

## 2026-10-02 · 发布与 Windows 套壳规划（仅文档） · Codex
- 完成：在 plan 新增阶段 5，写明现有平台限制、Tauri 2 + 内置 Bun + 完整 Nuxt 产物的拟议方案、兼容基础 / Windows 本地安装包 / Windows Release 的分包顺序、生命周期与安装验收、Mac 后续路线。同步 guide 5-1～5-3 卡片和 AGENTS 的停点规则；6 个新实现任务全部未打勾，既有任务状态未变。
- 用户最新要求：先做兼容，再把 Windows 套壳做出来；不直接往下做。5-2 交付本地 Windows 测试包后必须停下来等用户试用确认；Mac 套壳 / 发包须用户另行启动。本会话只写 plan，没有开始实现或创建 Release。
- 研究：只读核对项目 Releases（尚无发布）、llama.cpp nightly 指针 b11146 的三平台资产、cloudflared 2026.9.3 的 Darwin 资产及 Tauri / Bun / sharp 官方文档；链接在 plan。
- 验证：`bun test` 564 pass / 51 skip / 0 fail（当前 PATH 缺 sh）；仅为补齐跳过项，在该命令进程的 PATH 加入已安装 Git 的 bin 后运行 `bun test tests/platform/pre-commit.test.ts`，51 pass / 0 fail。`bun run typecheck` 通过。Bun 内联文档检查：ID 唯一、内部锚点与容器闭合有效，6 个新任务未完成、原任务不变；初次任务比较被 HTML 注释及换行差异误报，修正检查后通过。`git diff --check` 通过。
- 未运行：build、浏览器、GPU / 真实模型、Mac 真机、安装包；未读取 secrets、未修改 Cloudflare、未安装工具。只修改 plan / guide / handoff / AGENTS，无临时文件或常驻进程。
- 剩余：5-1～5-3 均未实现；选型需在 5-2 最小验证。许可证、签名、正式版本号待发布前确定；阶段 4 已披露边界不抹去（解压时限纳入 5-1，其余按 plan 发布清单评估）。
- 下一步：另开会话执行 5-1（跨平台兼容基础）；完成后再开 5-2，不在同一会话连续执行。

---

## 2026-10-02 · 阶段 4 第四轮复审意见处理（docs/reviews/stage-4-codex-r4.md） · Opus 5.5
- 完成：CR-027～CR-029 全部成立并已修复，CR-025 / CR-018 的「测试不经过生产接线」一并补上。pre-commit：引号加入反引号，声明排除只管不带引号的值，名称后的 TS 类型标注、名称行开串的分行值也拦（027）。Cloudflare 任务加服务端版本号 `{ boot, seq }`（`CloudflareSetup.view()`、快照 `cloudflareRev`、5 个接口都返回 `view()`），前端按版本取新、不再看连接状态（028）。hook 测试一次一跑 + 显式 30 秒预算，hook 加无进程预筛（029）。`server/service/cloudflare-hooks.ts`：端口守卫与成对保存的接线，context 与 `tests/service/` 共用。
- 验证：标准 `bun test`（不加超时参数，sh 在 PATH 上）两次均 615 通过 / 0 失败；`bun run typecheck` 0；新测试对旧代码的反证：旧 composable 3 条交错用例失败、端口接线改回读缓存后接线测试失败。构建：在临时 worktree 里 `bun run build` 通过，构建产物 + 临时数据目录（自动更新关）冒烟：`/api/cloudflare`、`/api/state`、`/api/stream`、dismiss 均带 rev，首页 200；已停已删。**没运行**：浏览器、真实 Cloudflare、真机。
- 剩余：同上一条（CR-007 两次写之间被杀、CR-009 解压无时限、CR-010 混合日志待确认、CR-013 历史）。
- 决定 / 坑：**用户在跑 start.bat 时不要在主目录 `bun run build`**：本次在主目录构建时 sharp 的 .node 被运行中的实例占用，构建先清空了 `.output` 再失败，运行实例的页面资源 500。已在临时 worktree 按运行实例对应的提交（1d5c7a6，靠资源哈希确认）重建并放回，页面恢复；运行实例的 `/api/state` 因缺文件期间首次加载失败被缓存，仍 500（界面不用它），重启实例即恢复。构建验证一律放临时 worktree。worktree 用 junction 共享 node_modules 会让 Nuxt 构建报错，要在 worktree 里 `bun install`。
- 下一步：没有新的工作包；第五轮复审可选。

## 2026-10-02 · 阶段 4 第三轮复审意见处理（docs/reviews/stage-4-codex-r3.md） · Sonnet 5.5
- 完成：CR-023～CR-026 共 4 条逐条核实，**全部成立并已修复**：pre-commit 用暂存文件的上一行判断分行凭据（只改值也能拦住），带引号字面量不要求数字、不带引号的值要求含数字且 `const/let/var` 声明和函数调用不算（023、024）；Cloudflare 任务的端口守卫先读磁盘再比较（025）；live 断线后 HTTP 结果重新生效、重连快照再接管（026）。
- 验证：`bun test` 571 通过 / 0 失败（39 个文件，sh 在 PATH 上，16 条 hook 测试全部执行）；`bun run typecheck` 退出码 0。**没运行**：build、浏览器、真实 Cloudflare、真机。
- 剩余：同上一条（CR-007 两次写之间被杀、CR-009 解压无时限、CR-010 混合日志待确认、CR-013 历史、`context` 接线无集成测试）。pre-commit 的已知误报边界：非声明语句里「属性 = 含数字的长标识符」，加 `pre-commit:allow`。
- 决定 / 坑：pre-commit 为查上一行对每个「像值」的新增行调用一次 `git show` + `sed`（仅这类行）。
- 下一步：没有新的工作包；第四轮复审可选。

---

## 2026-10-02 · 阶段 4 复审意见处理（docs/reviews/stage-4-codex-r2.md） · Sonnet 5.5
- 完成：复审 CR-014～CR-022 共 9 条逐条核实，**全部成立并已修复**（处理结果写在复审文件里）：pre-commit 分行赋值 / `CF_*` 名称 / 要求值含数字避免误报（014、015）；`mergeIngress` 按主机名 + 路径的实际命中验证，带 path 的通配规则不再算宽泛规则（016）；ingress 步骤用 `configHash` / `resultHash` 区分「仍是预览版本」与「恰好是预期结果」，混合则 changed（017）；`localPort` 钩子，端口变了就停（018）；`Hold` 退出时无论成败都对账一次（019）；`abortable` 预取消不留未处理拒绝、已取消不发请求（020）；收到 live 快照后 job 只由 live 更新（021）；DNS 恢复比较 `proxied`，被改过则拒绝清理并保留任务（022）。
- 验证：`bun test` 566 通过 / 0 失败（39 个文件，sh 在 PATH 上，pre-commit 测试全部执行；新增 composable、Hold、预取消、分行凭据、路径命中、端口、代理开关等约 11 条）；`bun run typecheck` 退出码 0。**没运行**：`bun run build`、浏览器、真实 Cloudflare、真机。
- 剩余：CR-007 两次写入之间进程被杀的恢复未做；CR-009 解压无取消 / 时限；CR-010 匿名注册 + 带索引注销的混合日志格式待确认；CR-013 已推送历史里的真实隧道名由用户决定；`context` 的 Hold / 保存接线没有集成测试；没有浏览器 / 真实 Cloudflare 验证。
- 决定 / 坑：`mergeIngress` 的语义见函数注释（新规则在会遮蔽它的无 path 规则之前、带 path 规则之后；自己的规则被宽泛规则遮蔽时移到前面）。`SetupPlan.resultHash`、`SetupHooks.localPort`、`i18n` 的 `changed-*` 新增，向后兼容。`tests/app/` 里用 `mock.module` 替代 Nuxt 的 `~~` 别名。pre-commit 现在对每个新增行多启动几次 grep，大提交会更慢（本机一次提交约 1 分钟）。
- 下一步：没有新的工作包；等 Codex 第三轮复审（可选）。

---

## 2026-10-02 · 阶段 4 审查意见处理（docs/reviews/stage-4-codex.md） · Sonnet 5.5
- 完成：13 条逐条对照代码核实，**12 条成立并已修复，CR-006 用户选方案 A（保持现状，失败卡片补恢复提示），0 条不成立**；每条的处理结果写在审查文件里。没有勾选 plan 任务。修复：pre-commit 识别隧道 token / API token 赋值（CR-001）；Cloudflare 放弃时恢复被改指的 DNS（002）；沿用隧道时保留完整远程 config（003）；ingress 合并保持优先级（004）；ingress 写入前校验配置未变、识别丢响应的自身写入（005）；secrets + settings 成对写入失败回滚、成功后才切换托管（007，`core/write-pair.ts`）；cloudflared 准备可取消、关闭 / 换 token 时等待（008）；更新 / 下载 HTTP 时限与关机取消（009，`NetOptions`、`Updater.stop()`）；Unregistered 日志按 connIndex 计数（010）；pid 登记失败不留 child（011）；Cloudflare 任务进入 live 快照（012）；交接里的真实隧道名改为泛化描述（013）。
- 验证：`bun test` 555 通过 / 0 失败（新增约 25 条，含 sh 下的 pre-commit 测试）；`bun run typecheck` 通过（退出码 0）。**没运行**：`bun run build`、浏览器里的「运行中刷新 / 另一标签页」场景（只有单测）、真实 Cloudflare（002/003/005 只有 FakeCloudflare）、真机。
- 剩余：CR-006 已按方案 A 处理（不自动认领；`tunnel-exists` / `dns-appeared` / `ingress-changed` 失败时提示「放弃后重新预览并确认」）。CR-003 真实 API 对缺省字段的语义未核实（现在原样回传，不依赖它）。CR-007：进程恰好在两次写入之间被杀的恢复未做。CR-013：已推送的历史提交里仍有真实隧道名，是否改写历史由用户决定。
- 决定 / 坑：`mergeIngress` 顺序变了（原位替换 / 插在会遮蔽它的规则之前），旧测试里「新规则在最前」的断言已改。`TunnelManager` 的 teardown 会等 prepare 结束，自定义 prepare 需要响应 `net.signal`。`SetupPlan` 新增 `configHash`，`SetupJob.created` 新增 `dnsRestore`，`StateDoc` 新增 `cloudflare`（均向后兼容）。
- 下一步：没有新的工作包（开发共 4 个阶段，阶段 4 已全部完成）。等 Codex 复审。

---

## 2026-10-02 · 工作包 4-6（接续：阶段 4 更新 / 回退验收） · Opus 5.5
- 完成：plan 阶段 4「真机试用」打勾，阶段 4 任务全部完成。没有改代码。
- 验证：`bun run build`、`bun test` 532 通过、`bun run typecheck` 通过。真机（临时数据目录：复制 settings.json（关公网 / 托管，端口 5099，模型端口 7300–7399）、models.json、templates/，不复制 secrets.json；已停已删，GPU 回到基线以下）：用 `installBuild` 真实下载安装旧版 b11140（CUDA 13.4，55 秒）并设为当前 → 启动构建产物，先监听、后台检查到官方最新 b11146 → 自动下载、校验、解压、设为当前（`ready / updated / from b11140`，约 30 秒）→ `POST /api/llamacpp/current {tag:b11140}` 回退（`switched`，settings.json 已写 b11140）→ Qwen3.8-27B 加载 43 秒 ready，对话返回 `ok`；系统进程表里 llama-server 的路径在 b11140 目录，该 exe `--version` 为 build 11140；`/api/llamacpp` 显示 b11140 current + inUse → 卸载、停止。用户真实 data 未改动（仍是 b11146）。
- 剩余：无（阶段 4 工作包全部完成）。**没测**：这次回退走的是接口，不是界面按钮（界面确认框在 4-2 用假目录验证过）；真实 cloudflared 配置行解析仍只有单测（见上一条）。
- 决定 / 坑：临时数据目录必须连 `data/templates/` 一起复制，否则带自定义模板的模型 `chat template not found` → failed，修好后要 `POST /api/models/:id/retry`（failed 不会被下一个请求自动重试，符合设计）。官方「最新」指针 2026-10-02 仍是 b11146（Release 列表里已有 b113xx，但指针没动）。
- 下一步：阶段关口 4（用户试用 → Codex 审查阶段 4 → 处理意见）。

---

## 2026-10-01 · 工作包 4-6（未完：阶段 4 更新 / 回退验收） · Opus 5.5
- 完成：plan 阶段 4「公网模块合并 + 引导」。`SettingsPublicAccess.vue`（未开启 / 引导 / 总览），`PublicWizard`（端口 → key → 方式 → 一键：API token / 地址 / 预览执行（`PublicCfRun`），或手动：教程 / 粘贴 token → 连接），`PublicOverview`、`PublicStatus`、`PublicAddresses`（地址 + 检测）、`PublicKeys`（原 SettingsKeys）、`PublicAdvanced`；`useCloudflareSetup` 共享 4-5 状态。删掉 SettingsPublic / SettingsTunnel / SettingsCloudflare。settings v3：`public.wizard`（`cleanWizard`，迁移）。`core/public-check.ts` + `POST /api/public/check`。`tunnel.ts`：`ingressHostnames` 从 cloudflared 的 `Updated to new configuration` 行取指向本机端口的主机名 → `TunnelInfo.hostnames`。`SettingsDoc.public.cloudflared`。README 公网一节改写。
- 验证：`bun test` 532 通过、`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录 + 假 Cloudflare（已停已删）在内置浏览器走完两条分支、再加一个地址、关闭、保存进度后刷新继续、v2→v3 真实文件迁移、错端口 / 错 token 被拒、深色 + 375px 无横向滚动、日志无 token / key。用户在真实环境（start.bat）远端跑通。
- 剩余：**阶段 4 验收「打开时自动下载新版 + 回退后用旧版本加载真实模型」仍未做**（占 GPU、下载约 1 GB，在临时数据目录里做：先装比 b11146 旧的真实版本 → 启动让更新器下载 b11146 → 回退 → 真实模型加载确认版本）。做完后给出阶段 4 验收结果表，再勾 plan「真机试用」。**没测**：真实 cloudflared 的配置行解析（只有按真实格式写的假进程单测；用户远端跑通但没核对地址列表）。
- 决定 / 坑：`useSettings.save` 正在保存时会拒绝第二次保存——引导里先保存再切步骤（`go()`），连接步骤等前一次保存结束再打开入口。Bun 的 fetch 把域名解析失败报成 `ConnectionRefused`，检测失败时再 `dns.lookup` 区分。Bun 下 `AbortSignal.timeout` 不算挂起任务，测试会卡死，用自己的定时器。`bun run dev` 下没有公网入口和隧道 → 530（用户踩到，已加醒目提示）；用户的 dev 服务器热重载时把真实 settings.json 迁到了 v3（有备份）。TaskStop 后 bun 子进程仍在，按 PID `taskkill /T`。
- 下一步：接续 4-6 剩余（阶段 4 更新 / 回退验收），之后阶段关口 4。

---

## 2026-10-01 · 工作包 4-5 · Opus 5.5
- 完成：plan 阶段 4「一键建隧道」。`server/core/cloudflare.ts`：`CfClient`（可注入 fetch，token 只放 Authorization 头）、`inspect`（校验用户 / 账号 token，列 zone，探测 Tunnel / DNS / Zone 读权限，缺哪项指出来；只有 active zone 可用）、`planSetup`（同名隧道 / CNAME 指向的隧道 / 当前托管隧道 → 选择；入口规则合并保留其他主机名；A/AAAA 或多条记录 → blocked；fingerprint）、`CloudflareSetup`（tunnel → ingress → dns → token → save，失败停在该步，重试从失败步继续，放弃只删本次新建的隧道 / DNS）。secrets.json → v3（`cloudflareToken`，迁移）。接口 `/api/cloudflare`、`/token`、`/zones`、`/preview`、`/apply`、`/retry`、`/cleanup`、`/dismiss`。界面 `SettingsCloudflare.vue`（token、建 token / 域名接入的说明、选域名、预览、确认框、步骤结果）。真机后追加：默认沿用正在托管的隧道（由隧道 token 解出 ID，`tunnelIdOf`），换域名 = 给它加一个地址；隧道名移入「高级」。README 公网一节重写（先决条件 / 方式 A 一键 / 方式 B 手动）。
- 验证：`bun test` 519 通过（新增 cloudflare 29、keys 3、tunnel 1）；`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录 + 假 Cloudflare（HTTP 包一层 fixture，已停已删）在内置浏览器：错 token 拒绝、好 token 列 zone、冲突选择、注入 DNS 失败 → 重试成功、403 失败 → 放弃只删新隧道、A 记录 blocked、手机宽度 + 深色无横向滚动；日志 / 接口无 token。真机（用户自己在界面操作）：第一个域名经隧道带 key 200、无 key 401、吊销 401、`/`、`/api/state` 404；第二个域名 401（可达）。
- 剩余：阶段 4 验收里**仍未验证**：真实的自动更新下载、真实模型下的回退（放进 4-6）。**没测**：「默认沿用当前隧道」在真实账号上的执行（只有单测 + 真实账号的只读预览）。
- 决定 / 坑：用户公司网络打不开第一个域名（不是程序问题；目标服务在别的机器上，本机测不到）。用户第二次建隧道时新建了隧道 llama-web 并替换了托管 token（多半是在修复生效前跑的），所以**第一个域名现在 530**（CNAME 仍指向无连接的旧隧道）；用新界面对该域名再跑一次即可改指（会改 DNS，先问用户），或在后台删掉旧隧道 / 记录。Cloudflare 不提供免费域名、API 不能代注册。测试用 `LLAMA_WEB_CLOUDFLARE_API` 指向假 Cloudflare。界面目前四张公网卡片并列，用户认为太复杂 → 4-6。
- 下一步：工作包 4-6「公网模块合并 + 引导 + 阶段 4 验收」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。

---

## 2026-10-01 · 工作包 4-4（含阶段 4 验收） · Opus 5.5
- 完成：plan 阶段 4「隧道托管」。`server/core/tunnel.ts`：`extractToken`（裸 token 或整条命令）、打码 / `redact`；查找 cloudflared（PATH + 常见安装位置）→ 复制到 `data/runtime/cloudflared/`，没有就从官方 Release 下载并校验 SHA-256；`TunnelManager`（token 走环境变量 `TUNNEL_TOKEN`，输出逐行脱敏，识别 Registered / Unregistered tunnel connection → 已连通；意外退出退避重试，token 无效不重试；pid 记入 pids.json，停止杀进程树）。仅在「公网入口监听中 + 已存 token + 托管开关开」时运行。settings.json → v2（删 `tunnelName`，加 `public.tunnelEnabled`，迁移函数）；secrets.json → v2（加 `tunnelToken`）。接口 `/api/tunnel/token`、`/api/tunnel/retry`；快照 `tunnel`、事件 `kind:'tunnel'`。界面：设置页「Cloudflare 隧道」卡片 + 带 SVG 示意图的分步指引；公网入口卡片去掉隧道名 / DNS 命令。README 隧道一节改写（并更正 secrets.json 是明文而非哈希）。
- 验证：`bun test` 全部通过（新增 tunnel 21 条含真实子进程、keys / settings / residue 若干）；`bun run typecheck`、`bun run build` 通过。真机（临时数据目录，端口 5097 / 18090，已停已删，GPU 回到基线）：已装 cloudflared 2026.5.0 被复制并运行；伪造 token 连不上时显示「正在连接」+ 最近报错；用户自己的 token：状态已连通（4 条连接）；经隧道无 key / 错 key / 吊销后的 key → 401，带 key 的 /v1/models 200，/api/state、/api/keys、/settings、/upstream、/ → 404；带 key 流式对话触发 Qwen3.8-27B 加载（41 秒）并出流；请求记录 source=public + key 名；token / key 未出现在日志、事件、server 输出；真实 settings.json 副本迁移到 v2 且生成备份；`git add -f data/x` 被 pre-commit 拒绝。
- 剩余：阶段 4 验收里**未验证**两项：官方出新版时的自动下载安装（当前官方最新仍是 b11146，没有可下载的）、真实模型下的版本回退（只有一个版本；回退逻辑在 4-2 用假目录验证过）。**没测**：cloudflared 下载路径的真实网络（只有假 fetch 的单测；本机已装）；Windows 服务形式的 cloudflared 与本隧道并存；深色模式 / 手机宽度下的新卡片；`nuxt dev` 下（只会显示「开发模式没有公网入口」）。
- 决定 / 坑：与 4-3 记录的差异——用 `TUNNEL_TOKEN` 环境变量代替 `--token`（不进进程列表）；已装的 cloudflared 复制到 `data/runtime/cloudflared/` 再运行，这样残留清理只杀 runtime 下进程的规则同样覆盖隧道。真实 cloudflared 遇到不存在的隧道 token 不会退出而是一直内部重试，所以界面显示「正在连接」+ 最近报错，而不是错误卡片。`dnsCommand` / `routeDnsCommand` / `bad-tunnel` 已删。Windows 上硬杀 llama-web 时 cloudflared 随管道关闭自己退出（观察到，不依赖它）。
- 下一步：新增工作包 4-5「一键建隧道」（Opus 5.5，见 claude-guide）；阶段关口 4 顺延到它之后。真机试用发现：用户真实 data 里存的是另一条隧道的 token（已清空并关闭托管开关），域名 CNAME 指向的那条旧隧道当前无连接且入口规则仍指向测试端口 18090，4-5 里一并处理。

---

## 2026-10-01 · 工作包 4-3 · Sonnet 5.5
- 完成：plan 阶段 4 第 7–8 项。`scripts/pre-commit`（POSIX sh）：拒绝 `data/`、`secrets.json`、`.env*`，扫描新增行的 `sk-…`、32 位以上十六进制串、Bearer token（报错不打印值）；行内标记 `pre-commit:allow` 放行假值；`docs/reviews/` 不查十六进制串（引用提交哈希）。`.gitattributes` 固定该脚本为 LF（`core.autocrlf=true` 下 CRLF 会让 sh 失败）。启用：`git config core.hooksPath scripts`（每个克隆一次）。`README.md`（中文）。
- 验证：`bun test` 457 通过（新增 `tests/platform/pre-commit.test.ts` 8 条，在临时 git 仓库里真实运行脚本）；`bun run typecheck` 通过；真实仓库里 `git add -f data/settings.json` 后运行脚本被拒绝。**没运行**：`bun run build`；阶段 4 真机试用（见下）。
- 剩余：阶段 4 第 9 项「真机试用」未做。**用户要求改隧道方案**（变更记录已写）：改为设置页填隧道 token，llama-web 自动检测 / 下载 cloudflared 并 `--token` 托管，带 Cloudflare 后台分步图文指引；用户本机已装 cloudflared。该部分拆成工作包 4-4（plan 新增任务、claude-guide 新增卡片）。
- 决定 / 坑：README 的隧道一节描述的是旧流程（手动 DNS 命令 + config.yml），4-4 要改写。设置页现有「需要手动执行的命令」「ingress 提示」在 4-4 一并替换；`dnsCommand` 相关代码和测试到时再处理。
- 下一步：工作包 4-4（Opus 5.5，含阶段 4 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 4-2 · Opus 5.5
- 完成：plan 阶段 4 第 4–6 项。`server/core/updater.ts`（`Updater`）：启动后台（等残留清理完）检查一次：采用已装版本 → 查官方最新（nightly-tag）→ 没装就下载 CUDA 构建 + cudart、SHA-256 校验、在 `.tmp-` 里解压、改名成版本目录 → 设为当前 → 清理旧版本。`llamacpp.ts` 拆出 `installBuild` / `clearLeftovers`，删掉 `ensureRuntime`。状态 `RuntimeStatus.ready.note`（latest / updated / pinned / auto-off / switched）、`error.using`（失败后继续用的版本）；事件带 `note` / `from`。接口 `GET /api/llamacpp`、`POST /api/llamacpp/current {tag}`。快照 `llamacpp.versions`（current / inUse）、`rollback`。界面：设置页「llama.cpp 版本」卡片（状态、版本列表、切换 / 回退）；全局确认框 `LlamacppSwitchModal`；失败卡片在「当前是最新安装的版本且有旧版本」时提示回退（oom / 文件 / 端口 / 参数 / 需更新版本这几类不提示）。
- 验证：`bun test` 449 通过（新增 updater 18 条，含 Windows 上目录被别的进程占用时整体保留；live 1 条；fake GitHub 移到 `tests/fixtures/fake-github.ts`）；`bun run typecheck`、`bun run build` 通过。构建产物 + 临时数据目录（端口 5096，已停已删）：真实 GitHub 查询到最新 b11146（已放假目录，未下载）→ 手动选的 b11000 保持当前（pinned）、第 3 个旧版本被清理、`.tmp-` 残留被清除；切换接口成功 / 未安装 404 / 非法 400 / 跨站 403；内置浏览器里假模型（空 exe → spawn-failed）失败卡片出现「回退到 b11000」，确认框 → 切换成功，顶栏和总览更新，提示消失；设置页卡片正常，控制台无错误。**没测**：真实下载一个新版本并替换（当前没有更新的官方版本，下载路径只有单测 + 1-6 的首次下载）；真实 llama-server 运行时其版本目录不被删（单测覆盖）；网络失败时的界面文字（单测覆盖状态）；深色模式下的新卡片。
- 剩余：无。
- 决定 / 坑：
  - 只有「下载了新版本」才设为当前；回退后的选择在下次打开时保持，直到官方发布更新的版本（plan 变更记录已写）。下载期间手动切换的版本也不会被覆盖。
  - 保留：最新 `keepVersions` 个（至少 2）∪ 当前 ∪ 正在运行 / 启动中的进程所在目录，所以可能临时多于 2 个。删除前先改名为 `.del-…`，改名失败（被占用）就整体保留。
  - 切换版本不重启正在运行的模型；卸载后再加载才用新版本（确认框里有说明）。
  - `autoUpdate` / `keepVersions` / `cudaRuntime` 仍只能手改 settings.json（界面只读显示）。
  - 新建的 models.json 不会被文件监听发现（watcher 只盯启动时已存在的文件），需要重启；不是本工作包改的。Bash 后台任务被 TaskStop 后 bun 子进程可能还活着，按端口查 PID 结束。
- 下一步：工作包 4-3（Sonnet 5.5，含阶段 4 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 4-1 · Opus 5.5
- 完成：plan 阶段 4 第 1–3 项。`server/core/public-entry.ts`：`handlePublic`（先查路径：只有 `/v1/*`，且不含 `%2e` `%2f` `%5c` `\`，其余 404 且不看 key；再查 `Authorization: Bearer`，失败统一 401 + `WWW-Authenticate`；通过后在进程内调 `proxy.handleV1(req, { ip, keyName })`；内部异常给通用 500）；`PublicListener`（只绑 127.0.0.1，`enabled` / `port` 变化才重启监听，绑定失败显示原因并在下次保存时重试；没挂监听实现时为 unavailable）。`server/core/keys.ts`：`sk-` + 32 字节随机、sha256 + timingSafeEqual 遍历全部 key、吊销保留在列表、名称在未吊销 key 中唯一、打码 `sk-AbCd…wxYz`。`data/secrets.json`（version 1，JsonStore 原子写 + 备份，读坏了按「没有 key」处理）。接口 `/api/keys`（GET 打码列表、POST 新建返回一次明文、`POST /:id/reveal`、`POST /:id/revoke`）。设置：`public` 段（开关、端口、域名、隧道名），`SettingsDoc.public` 带监听状态、`dnsCommand`、可用 key 数。界面：设置页「公网入口」「API key」两张卡片（吊销用确认框）。
- 验证：`bun test` 432 通过（新增 keys 20、public-entry 22（含真实 socket 端到端）、settings-admin 6）；`bun run typecheck`、`bun run build` 通过。构建产物实测（临时数据目录、主端口 5098、公网 18089、关闭自动下载、不加载模型，已停已删）：无 key / 错 key → 401，有效 key `/v1/models` 200；`/`、`/settings`、`/api/state|stream|keys|settings`、`/upstream/x/props`、`/_nuxt/`、`/favicon.ico`、`/v1`、`/v1/%2e%2e/...`、`--path-as-is /v1/../api/state` 带 key GET/POST 全部 404；本机局域网地址连 18089 被拒（只监听 127.0.0.1）；吊销后立即 401；请求记录 `source: public` + key 名，key 明文未出现在请求 / 事件日志和控制台；关闭开关后端口释放；跨站 POST 吊销 403。浏览器里新建 / 查看 / 吊销确认框可用。**没测**：真实 Cloudflare 隧道（4-3 验收）；经公网入口触发真实模型加载与流式（只用了假上游的单测）；开发模式。
- 剩余：无。
- 决定 / 坑：
  - **来源识别改为进程内传参**（用户确认，plan 已改「来源识别」并加变更记录），没有内部头。
  - 公网开关 / 端口**保存后立即生效**，关闭时 `stop(true)` 中断进行中的公网请求；`nuxt dev` 下没有公网入口（界面会说明）。
  - 401 不记请求记录（只有通过鉴权的请求进入 `/v1` 处理）。`allowSwitch` 仍是坑位，只存不用。
  - 从 Git Bash 用 curl 发中文 JSON 会变乱码（不是程序问题）；测试时用英文名或界面。
- 下一步：工作包 4-2（Opus 5.5）。

---

## 2026-10-01 · 阶段 3 审查意见处理 · Sonnet 5.5
- 完成：`docs/reviews/stage-3-codex.md` 6 条：CR-001/002/003/004/005 核实成立并修复，CR-006 不成立（理由见文件）。CR-001：失败卡片的输出末尾对绝对路径脱敏（`redactPaths`，在 `diagnose()` 出口）。CR-002：日志读取用 `lstat` 拒绝符号链接。CR-003：`UsageTap` 单个超大块只留末尾 keep 字节。CR-004：加载进度采样移到 `trackWeightLoad`（`load-progress.ts`），单飞、stop 后丢弃在途结果。CR-005：OOM / bad-model 规则收紧，Info / Debug 行不参与分类。
- 验证：`bun test` 387 通过（新增 errors 5、request-log 2、logs 1、load-progress 3）；`bun run typecheck` 通过。**没运行**：build、真机（本轮没有改变真机行为之外的东西，但 `trackWeightLoad` 搬了位置、错误规则收紧后没有再用真实 llama-server 复测）。
- 剩余：无。局限：错误规则对「无等级标记的普通行里同时含这些词」仍可能误判；符号链接测试在无权限的机器上会被跳过；在途 nvidia-smi 不取消（最多 3 秒）。
- 下一步：阶段 3 关口——用户确认后开始 4-1（Opus 5.5）。

---

## 2026-10-01 · 3-3 补丁：加载进度 · Sonnet 5.5
- 完成：修真机加载进度不动。原因：当前 llama.cpp（b11146）加载时几乎不输出（只有 `loading model` → `llama threadpool init` → `creating MTP draft context` → `load_model: initializing` → `llama_server: model loaded`），没有点号行，旧里程碑也匹配不上。现在：新增这几条里程碑；加载期间每秒按 GPU 显存增长 ÷ 权重文件大小（model + mmproj + draft，`LaunchPlan.weightFiles`）推进 12→90%，没有 nvidia-smi 时用时间曲线（τ=15s）；`LoadProgress.estimate()`，`trackWeightLoad`（context.ts）；只增不减，里程碑更靠前时以里程碑为准。
- 验证：`bun test`、`bun run typecheck`、`bun run build` 通过（load-progress 新增 3 条）。真机（Qwen3.8-27B，临时数据目录，已停已删）：热缓存加载 8 秒，进度 12 → 14 → 85 → 94 → ready。**没测**：冷缓存长加载（预期更平滑）；无 nvidia-smi 的机器；多 GPU（按总显存增长算）；有别的程序同时占显存时进度可能被带偏（只会提前，不会倒退，就绪后归零）。
- 剩余：无。部分卸载（-ngl 小于全部层）时显存增长小于文件大小，进度会停在中段直到里程碑。
- 下一步：阶段 3 关口，用户确认后 4-1。

---

## 2026-10-01 · 工作包 3-3（含阶段 3 验收） · Sonnet 5.5
- 完成：plan 阶段 3 第 7–9 项。`server/core/errors.ts`：按进程最后输出 + 退出码识别 oom / cuda-error / dll-missing / file-missing / unknown-arg / mmproj-mismatch / unsupported-arch / bad-model / port-in-use，认不出保留 `exited` / `timeout` / `crashed` 等原因码（顺序敏感，显存不足优先于笼统的 failed to load model）。`ModelCrashError` 现在带最后 30 行和退出码（`ModelProcess.tail?`）。快照 `instances[].failure`（kind、exitCode、tail）；`errorText` 和 `/v1` 503 报错用识别后的 kind（事件里只有 kind，不含输出）。界面 `FailureCard`（总览 + 模型卡片）：中文原因 + 建议 + 「不会自动重试」+ 最后 30 行 + 「查看完整日志」（`/logs?model=<id>` 预选模型）+ 重试。
- 验证：`bun test` 373 通过（新增 errors 22、live 1、scheduler 1）；`bun run typecheck`、`bun run build` 通过。**阶段 3 真机验收**（RTX 5090、临时数据目录、端口 5094、b11146 拷贝、Qwen3.8-27B，用完已停已删，显存回到基线约 3 GB）：
  - ctx=4000000 + f16 KV：36 秒后失败，界面「显存不足」+ 建议 + 最后 29 行（末行 `failed to allocate buffer for kv cache`），第二次请求 0.2 秒内直接 503，没有重试 → 通过。
  - 流式生成：顶栏 / 总览实时 89.0 t/s；结束后「上次：提示处理 51.6 · 生成 89.5」，llama-server 自己的 timings 为 51.55 / 89.46（另一次 676.9 / 91.8 也一致）→ 通过。
  - 外部杀掉 llama-server → `crashed` 卡片（退出码 255、30 行）；硬杀 llama-web 重启后 `/api/logs` 仍列出两次运行的模型日志，最后一行 `# llama-web: exited code=255` → 通过。
- 剩余：无。**没测**：真实环境下的未知参数 / mmproj 不匹配 / 文件缺失 / 缺 DLL（只用合成输出单测，OOM 用了真实输出）；浏览器里点「查看完整日志」后的跳转（只测了接口和链接构造）；多 GPU；手机宽度下的卡片。
- 决定 / 坑：
  - **加载进度在真实 llama-server 上基本不动**：27B 加载 ~35 秒，进度停在 3% 直到就绪（3-2 预告的风险成真，点号行没有被识别 / 没出现）。plan 里该项已勾，但真机上体验差，建议下一步按模型文件大小或显存增长估算。
  - 失败卡片的输出末尾含模型路径（只在界面，不落盘到事件）；提交内容无个人路径。
  - `pkill` 在此环境不存在；`bun run build` 会因 `.output` 被运行中的服务占用而失败，先停服务。
- 下一步：阶段 3 关口——请用户试用并确认后再开始 4-1（Opus 5.5）。

---

## 2026-10-01 · 工作包 3-2 · Sonnet 5.5
- 完成：plan 阶段 3 第 4–6 项。`server/core/speed.ts`（`SpeedMeter`）：流式时数 SSE 的 `data:` 事件（行首匹配，一次原生字节搜索，不解码）按 3 秒窗口估 t/s，结束后用响应末尾 `timings`（`UsageTap.result()` 新增 `promptPerSecond` / `predictedPerSecond`）替换；没有 timings 时用整段平均并标「估算」；非流式只取 timings。`load-progress.ts`（`LoadProgress`）：按日志里程碑（不依赖 `函数名:` 前缀）+ 权重加载的点号行（无换行，所以 `runner` 新增 `onPartial`）估算 0..99%，只增不减；进度进快照 `instances[].progress`（仅 loading），也接到流式等待加载的 `: loading N%` 心跳（`progressOf`）。`gpu.ts`（`GpuSampler`）：按 `settings.gpu.sampleSec`（≥0.5 秒）采样 `nvidia-smi`，**只在有浏览器连着 `/api/stream` 时采样**，没有 nvidia-smi 就 `available:false`（总览不显示显存卡），每 60 秒重试一次。`LiveHub` 新增 `metrics` 消息（速度 + 显存，250ms 合并、相同不推、慢读者只保留最新），连接时先发一帧。界面：总览加载进度条+百分比、运行中模型的实时 / 上次速度、显存卡；顶栏显示正在生成的 t/s。
- 验证：`bun test` 349 通过（新增 speed 10、load-progress 4、gpu 6，live +3、proxy +4、runner +1、request-log +1，并改了 live 一条断言；fake-llama-server 加了 `dots` 模式）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译的假 llama-server（会输出里程碑、无换行点号行、流式带 timings；临时数据目录、端口 5097，已停已删）在内置浏览器实测：加载中进度 20→51→86→93 并显示「加载进度约 78%」、生成中 21 t/s（顶栏同步）、结束后显示「上次：提示处理 812.3 t/s · 生成 24.9 t/s」；显存卡读到本机真实 nvidia-smi。**没测**：真实 llama-server 的日志（只用 `llama.dll` 里的字符串确认了 `loading model tensors` / `offloaded %d/%d layers` / `loaded meta data with` / `constructing llama_context` / `llama_kv_cache` / `compute buffer size` 存在；`main: model loaded`、`initializing slots` 以及点号行是否真的会出现没确认）；真实生成速度与 llama-server 自身统计对比；多 GPU；没有 nvidia-smi 的机器上的界面。
- 剩余：无。
- 决定 / 坑：
  - `metrics` 不放进 snapshot（速度每秒变化，会让快照 diff 失效）；前端从 `useLive().metrics` 读。
  - 速度只按「有 modelId 的 /v1 请求」统计；`/upstream` 不统计；streaming 请求在上游返回响应头后才算开始（`prompt` 阶段只在头已到、首 token 未到时出现）。
  - 若真实 llama-server 不打点号行，进度会在 10% → 91% 之间不动（只剩里程碑）；3-3 真机时留意，必要时改成按模型文件大小 / 显存增长估算。
  - Bash 的 heredoc 遇到中文 / 引号 / 反斜杠常整条失败：写文件用 Write 工具，改文件用 Python 脚本文件（别在 heredoc 里写 `\b` 之类转义，会被吃成控制字符）。
- 下一步：工作包 3-3（Sonnet 5.5，含阶段 3 验收，真机测试前先告诉用户）。

---

## 2026-10-01 · 工作包 3-1 · Sonnet 5.5
- 完成：plan 阶段 3 前三项。`server/core/logs.ts`（`LogStore`）：模型输出每次启动一个 `data/logs/models/<模型>/时间.log`（缓冲 200ms 写盘，退出时写一行 `# llama-web: exited …`），事件 / 请求按天 `events|requests/日期.jsonl`；按 `settings.logs` 清理（每模型保留最近 N 个，不删仍打开的；jsonl 保留 keepDays 天），启动、每次新启动、跨天时清理；读取只认固定文件名格式（防路径穿越）。`server/core/request-log.ts` + `proxy.ts`：每个 `/v1` 请求结束时产出一条记录（时间、来源、模型/方案、状态、结果 ok/error/aborted、耗时、token、图片压缩前后、参数摘要）；`GET /v1/models` 和 `/upstream` 不记。`live.ts`：新增 `request` / `log` 消息及 `request-history` / `log-history`，`onActivity` 用于事件落盘。接口 `GET /api/logs`、`GET /api/logs/file`。日志页三个标签、实时 / 历史文件切换、模型筛选、搜索、暂停、自动跟随滚动。
- 验证：`bun test` 320 通过（新增 logs 11、request-log 9、proxy 记录 7、live 5 条，并修了 `readFrames` 测试辅助函数会丢块的问题）；`bun run typecheck` 通过；`bun run build` 通过。构建产物 + 编译成的假 llama-server（临时数据目录、端口 5097，已停已删）实测：非流式 / 流式 / 404 三种请求各一条记录、token 正确；对话内容与 Authorization 全文搜索日志目录为 0 命中；重启后内置浏览器在日志页能看到上次的请求记录和模型输出。**没测**：真实 llama-server / GPU；公网来源（key 名字段已预留，4-1 接入）；局域网来源在真机上的判定（只有单元测试）；事件标签的界面（只看了模型输出和请求两个标签）。
- 剩余：无。
- 决定 / 坑：
  - 请求记录的参数只取白名单标量（采样、max_tokens、reasoning / thinking 开关等）和 messages / tools 的**个数**；`stop`、`user`、`response_format` 等一律不记。
  - 来源：`handleV1(req, { ip, keyName })`。回环地址和本机自己的网卡地址 = 本机，其他 = 局域网，有 `keyName` = 公网。4-1 的公网入口调用时传 `keyName`。
  - 实时输出行经 `/api/stream`（`log` 批量消息）；读者跟不上时丢弃最旧的输出批次（文件里有全量），活动 / 请求事件仍按旧规则（超限断开）。
  - token 数从响应末尾 16KB 里正则取 `prompt_tokens` / `completion_tokens`，不逐块解码，不影响流式转发；超大非流式响应若 usage 不在末尾则记为空。
  - 顺手修了布局：`main` 加 `min-w-0`，宽表格不再撑出整页横向滚动。删除了不再使用的 `PagePlaceholder` 组件。
  - Bash 工具的 heredoc 遇到引号 / 反斜杠组合会整条命令解析失败；改用 Write 工具写文件。
- 下一步：工作包 3-2（Sonnet 5.5）。

---

## 2026-10-01 · 阶段 2 关口 · Opus 5.5
- 完成：在界面里验证了下拉空值修复并给 plan 对应任务打勾。构建产物 + 临时数据目录（端口 5097，已停已删）在内置浏览器实测：设置页 K 缓存类型出现「不传」，选中保存后 `cacheTypeK: null`，刷新仍显示「不传」；模型编辑 mmproj 选文件保存 → 选回「不使用」保存 → `mmproj: null`；聊天模板选 `chat.jinja` 保存 → 选回内置保存 → 字段为空；控制台无错误。
- 阶段 2 状态：plan 阶段 2 任务全部打勾；Codex 审查 5 轮，CR-001～CR-010 已复审关闭，CR-011 已修复未复审。用户确认进入阶段 3，**未亲自试用**。以下验收项至今**没有人实际做过**：酒馆实际连接；往目录放新 gguf → 扫描 → 启用 → 酒馆使用；`名字:RP` 在酒馆里调用；预览命令粘贴到 CMD 手动跑真实 llama-server；长时间深色模式观感。后续出问题时优先怀疑这些。
- 下一步：工作包 3-1（Sonnet 5.5）。

---

## 2026-10-01 · 下拉空值修复 · Sonnet 5.5
- 完成：设置页全局默认参数、模型编辑 mmproj / draft、方案表单聊天模板的「空值」选项恢复显示并能选回。原因：reka-ui 的 `SelectItem` 对 `value === ''` 直接抛错（`SelectItem.js`，`''` 表示清除选择），所以空值选项渲染失败、选了别的就回不去。修法：新增 `app/utils/select-empty.ts`，空值选项用哨兵值 `__none__` 传给下拉，进出时与 `''` 互转；存储格式不变（仍是 `''` / `null`）。
- 验证：`bun test` 288 通过（新增 `tests/app/select-empty.test.ts` 5 条；只回退组件改动时「组件不得再构造 value 为 '' 的下拉项」这条失败）；`bun run typecheck` 通过。**没运行**：浏览器界面（项目没有 DOM 测试库，没新增依赖；也没用真实 data 目录起开发服务器）。
- 剩余：plan 阶段 2「修复下拉空值」**未打勾**——还需在界面里实际点一遍：选别的值再选回「不传 / 无 / 内置模板」，保存后刷新确认。
- 决定 / 坑：测试只能在源码层面锁住「库的规则」和「组件不再写 value: ''」，覆盖不到真实渲染。
- 下一步：用户试用并确认阶段 2 → 3-1。

---

## 2026-10-01 · 阶段 2 第五轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r5.md` 的 CR-011 已修复并标注：`ModelOps.switchTo` 判断「后面还有任务会让目标下线」时检查整个队列（含其他模型），不再只看同一模型的其他方案。CR-009、CR-010 已由复审关闭。
- 验证：`bun test` 283 通过（新增 2 条，只回退产品代码时这 2 条失败）；`bun run typecheck` 通过。本轮没有做真实 HTTP 复现，也没有运行 build（只改了一行判断条件）。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做；阶段 2 的真实界面试用、酒馆连接由用户在关口完成。
- 下一步：修下拉空值问题（Sonnet 5.5）→ 用户试用并确认阶段 2 → 开始 3-1。是否再做第六轮复审由用户决定。

---

## 2026-10-01 · 阶段 2 第四轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r4.md` 的 CR-009、CR-010 已修复并标注。`Scheduler.start(target, { last, reload })`：`last` 在队尾新建任务、不并入更早的同目标任务；`reload` 让在此之前创建的同方案实例（等它的请求结束后）被卸载并重新启动。实例新增 `born` 序号。`ModelOps`：切换方案 / 撤回手动启动后的新目标用 `last`；保存后重启用 `last + reload`；已在目标方案上但有其他方案请求排队时，在队尾补一个回到它的任务。
- 验证：`bun test` 281 通过（model-ops 新增 6 条，修复前其中 3 条失败）；`bun run typecheck`、`bun run build` 通过。构建产物 + 3 秒才就绪且记录启动参数的假 llama-server（临时数据目录、端口 5097，已停已删）真实接口：CR-009 两次启动依次 `ctx=262144`、`ctx=8192`，客户端 200；CR-010 B、C 客户端 200，最终 `B ready`。**没测**：GPU；macOS / Linux；浏览器界面。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做。
- 决定 / 坑：管理操作永远排在已排队的客户端请求之后（FIFO），代价是切换 / 保存后可能先加载一次旧请求要的方案再换回来。被显式停止或更晚的管理操作取代的重启会静默结束（不报错）。
- 下一步：用户决定是否让 Codex 做第五轮复审（`stage-2-codex-r5.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-10-01 · 阶段 2 第三轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r3.md` 的 CR-008 已修复、CR-005 余项已修复（一种组合改为警告），已标注。CR-008：`Scheduler.stop(modelId, { keepRequests: true })` 只撤回手动调用方，保留排队客户端请求及其正在进行的加载；`ModelOps.restart`（切换方案 / 保存后重启）改用它，显式停止不变。CR-005：`quoteCmdProgram` 改为无空白时给 `( ) % ! ^ & | < > ; , =` 加 `^`、有空白时加双引号；「空白 + 成对 %」在预览里给警告 `preview-program-percent`。
- 验证：`bun test` 276 通过（新增 model-ops 3 条、scheduler 1 条、launch 1 条，真实 cmd 程序路径用例 +3）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，已停已删）真实接口复现 CR-008：客户端 `mmm:A` 200，最终 `B ready`。真实 cmd 探测了程序路径 `%` 的三种写法（见审查文件）。**没测**：`cmd /v:on`；交互式 CMD 窗口粘贴；macOS / Linux；GPU。
- 剩余：plan 阶段 2「下拉空值选项不显示」仍未做。
- 决定 / 坑：「已排队的客户端请求保持请求时的方案」现在在所有切换分支都成立（含同一模型在 drain、待重启）；只有显式停止会拒绝排队请求。新方案排在保留的请求之后（FIFO），所以切换后会先加载一次旧请求要的方案。
- 下一步：用户决定是否让 Codex 做第四轮复审（`stage-2-codex-r4.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-09-30 · 阶段 2 第二轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex-r2.md` 的 CR-001 / CR-005 余项已修复，CR-007 已核实（Windows 实测不构成错误）并加固，CR-004 的边界说明已认可，各条已标注。CR-001：`Scheduler.cancelManual()` 只撤回手动 start/retry 调用方；`ModelOps.switchTo` 撤回其他方案的排队手动启动并按新方案启动；`snapshot().queue` 不列已取消的任务；后台日志不再把 `stopped` 记成错误。CR-005：新增 `quoteCmdProgram`，程序路径含空白或 `( ) & | < > ^ % ! ; , =` 时用普通双引号。CR-007：参数里的括号也加 `^`。
- 验证：`bun test` 271 通过（新增 model-ops 3 条、scheduler 1 条、真实 cmd.exe 测试 2 条：只含括号的参数 / `; , =`，以及程序路径含空格与元字符）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，已停已删）经真实接口复现审查场景：其他模型 drain 中手动启动 mmm、再切 RP → 队列 `[mmm:RP]`、`inUse` 只有 RP、最终 `mmm:RP ready`，从未启动 `mmm:默认`，日志无错误。**没测**：`cmd /v:on`；交互式 CMD 窗口里手动粘贴；macOS / Linux 上的全量测试；GPU。
- 剩余：plan 阶段 2 的「下拉空值选项不显示」任务仍未做（上一条交接）。
- 决定 / 坑：客户端请求已经排队等方案 A 时切到 B，这个请求仍加载 A（请求时已选定方案），切换只取代管理操作（手动启动 / 重试 / 重启）。以后要改成「切换也取消排队请求」，需要先和用户确认。
- 下一步：用户决定是否再让 Codex 复审（`stage-2-codex-r3.md`）→ 修下拉空值问题 → 阶段 2 确认后开始 3-1。

---

## 2026-09-30 · 阶段 2 审查意见处理 · Opus 5.5
- 完成：`docs/reviews/stage-2-codex.md` 6 条全部核实成立并修复，每条后已标注「处理」。CR-001/003：新增 `server/core/model-ops.ts`（`ctx.ops`），管理操作按模型递增代数，后发起的操作使等待 drain 的旧重启失效；draining 不再算「已在该方案运行」；改名 / 删除检查实例 + 调度队列 + 待重启目标（`GET /api/models/:id` 新增 `inUse`，抽屉按它禁用按钮）。CR-002：深度输入在 `update:model-value` 转字符串。CR-004：`handleStream` 每连接有界（最新快照合并、activity ≤200 超限断开、背压时跳过心跳、`pull()` 补发）。CR-005：Windows 预览改 `formatCmdCommand`（CMD 转义），界面注明粘贴到 CMD。CR-006：设置测试改用宿主绝对路径，大小写专项仅 Windows。
- 验证：`bun test` 265 通过（新增 model-ops 9 条、live 背压 3 条、args 1 条、`tests/platform/cmd-preview.test.ts` 4 条，后者用真实 cmd.exe 回读参数数组）；`bun run typecheck`、`bun run build` 通过。构建产物 + 慢响应假 llama-server（临时数据目录、端口 5097，用完已停、已删）经真实接口复现 CR-001（A→B→A drain 中，最终默认 ready、没有启动 RP）和 CR-003（排队中的 RP 删除 409、改名中文提示）；内置浏览器测了设置页深度输入（键入、步进、超限、清空、保存落盘）。**没测**：macOS / Linux 上的全量测试；真实 llama-server / GPU；把预览命令粘贴到真实 llama-server 手动运行；编辑抽屉在排队时按钮禁用的界面效果（只测了接口）。
- 剩余：审查外新发现的问题，已加入 plan 阶段 2 任务（未打勾）：值为 `''` 的下拉选项（设置页全局默认的「不传」、模型编辑的 mmproj/draft「无」、方案表单的「内置模板」）不渲染，控制台报 Reka `SelectItem` 空值错误——用户目前无法在下拉里选回「不传 / 无」。按规则没有顺手修。
- 决定 / 坑：
  - 路由里不要直接调 `scheduler.start/stop/retry`，一律走 `ctx.ops`，否则会绕过代数失效机制。
  - 预览命令目标 shell 定为 CMD：PowerShell 5.1 向原生程序传参不转义内嵌双引号，无法与参数数组一致。非 Windows 仍用 `formatCommand`。
  - Git Bash 里 curl 直接发中文 JSON 会乱码（服务端 404），实测时请求体用 node 写成 UTF-8 文件再 `-d @file`。Bash heredoc 依旧会吃反斜杠，含 `\` 的内容用 Write/Edit。
  - 每连接 2 秒轮询没有移到 hub（`notify()` 已合并去重），审查里这条是可选建议。
- 下一步：用户确认阶段 2（可再请 Codex 复审本次修复）→ 修上面的下拉空值问题（小修，Sonnet 5.5）→ 确认后开始 3-1。

---

## 2026-09-30 · 工作包 2-4 · Sonnet 5.5
- 完成：plan 阶段 2 第 9–11 项。设置页四张卡片（`SettingsDirs` / `SettingsDefaults` / `SettingsImage` / `SettingsServer`，各自保存）；首次启动向导 `/setup`（llama.cpp 状态、添加目录并扫描、旧配置导入，完成或跳过写 `settings.setup.done`）。后端校验在 `server/core/settings-admin.ts`（`applySettingsPatch` 等纯函数），接口 `GET/POST /api/settings`（补丁按段：modelDirs / defaults / image / server / setupDone，整个补丁校验通过才写）。快照新增 `firstRun`，布局在首次快照为 firstRun 时跳一次 `/setup`。
- 验证：`bun test` 247 通过（新增 `tests/core/settings-admin.test.ts`、`live.test.ts` 1 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译的假 llama-server（临时数据目录，已删）在内置浏览器实测：向导重定向、相对路径被拒（中文）、添加目录并扫描、旧配置导入、设置页四段保存（settings.json 与备份落盘）、端口改后的重启提示、删除被引用目录 409、全局默认值进入命令预览、手机宽度 + 深色。**真机**（临时数据目录 + 端口 5094，复用 b11146 的拷贝，`autoUpdate=false`，模型目录只读扫描，测完进程已停、显存回到基线、临时目录已删）：向导添加真实目录扫出 3 个模型；UI 启用 Qwen3.8-27B；mmproj 选择、RP 方案复制、方案切换、全局 ctx 改 32768 用接口完成（对应界面 2-3 已用假进程测过）；`qwen3.8-27b:RP` 经 `/v1/chat/completions` 真实加载并流式 / 非流式回复；切换当前方案触发自动重启（RP → 默认）；**预览命令与 `Get-CimInstance` 读到的真实 llama-server 命令行逐字一致**（端口 7100 也一致）。
- 剩余：无代码剩余。**没测**：酒馆（SillyTavern）实际连接；往目录里新放一个 gguf 再扫描（用了已存在的文件）；把预览命令复制到命令行手动跑一遍（只比对了字符串和真实进程命令行）；长时间看深色界面是否刺眼（需要用户判断）；`nuxt dev` 下的 `/api/settings`；设置页在真实浏览器里的 Tab 键盘操作。
- 决定 / 坑：
  - 新增 `settings.setup.done`（加性字段，`normalizeSettings` 补默认，未写迁移）。向导只在「没目录、没模型、没标记完成」时出现。
  - 监听端口改动只在重启后生效；`ctx.bootPort` 记的是进程启动时读到的 `settings.server.port`，若用 `PORT` / `NITRO_PORT` 环境变量覆盖了端口，提示里的「当前进程使用」会不准。
  - 被已启用模型（file / mmproj / draft）引用的目录不能删，只能停用或改路径；目录 id 保持不变（模型记的是 id）。
  - 调度卡片只开放监听端口、llama-server 端口范围、加载超时、切换等待上限；上限 X 只读显示 1；公网端口 / key / llama.cpp 版本留给阶段 4。
  - Bash 工具的 heredoc 遇到中文 + 引号混合偶尔整条失败，长文件用 Write 工具；Bash 里 `sed` 会吃反斜杠，改含 `\` 的 i18n 用 Edit。
- 下一步：**阶段关口 2**：用户试用界面（重点看好不好用、刺不刺眼）→ Codex 审查（阶段号 2）→ Claude 处理意见 → 确认后开始 3-1。

---

## 2026-09-30 · 工作包 2-3 · Sonnet 5.5
- 完成：plan 阶段 2 第 6–8 项（模型编辑：文件区 + 聊天模板；参数表单 + 命令预览；配置方案增删改）。后端纯函数在 `server/core/models-admin.ts`（`applyFiles` / `saveProfile` / `createProfile` / `renameProfile` / `deleteProfile` / `sanitizeForm` / `listTemplates`），命令预览 `previewLaunch`（`server/core/launch.ts`，和 `planLaunch` 用同一个 `buildLaunchArgs`，缺文件 / 缺 runtime 不抛错而是报 `missing`）。接口：`GET /api/models/:id`（配置 + 全局默认 + 模板列表 + 在跑的方案）、`POST /api/models/:id/{files,preview,profiles}`。前端：`ModelEditor`（抽屉：文件区 + 方案管理）、`ProfileForm`（每个方案一份，常驻挂载，切换方案不丢未保存修改）、`useParamFields`。
- 验证：`bun test` 227 通过（新增 `tests/core/models-edit.test.ts`、`launch.test.ts` 的 previewLaunch 5 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录、端口 5098，用完已停、已删）在内置浏览器实测：选 mmproj 保存（models.json 写入）、新建方案、继承 / 自定义切换后预览实时变化、额外参数重复 / 保留参数警告、保存方案；**真实进程命令行与预览逐字一致**（仅端口由预览示例值 7100 对应实际分配）；运行中保存并重启、改名 / 删除被拒（中文提示）；手机宽度 + 深色。**没测**：真实 llama-server / GPU；`nuxt dev` 下的新接口；草稿模型下拉（只测了 mmproj）；聊天模板在界面上的选择（接口测了，`--chat-template-file` 进了命令）。
- 剩余：无。聊天模板只能从 `data/templates/` 里已有的文件选（导入旧配置会复制进去），界面没有上传 / 新增模板入口（不在任务里）。
- 决定 / 坑：
  - 聊天模板是**方案级**字段（plan 配置结构如此），所以选择控件在方案表单里，不在文件区。
  - 方案接口合成一个 `POST /api/models/:id/profiles`（`op`: create / duplicate / rename / delete / save），名字走 body，不放 URL（中文名 + 解码问题）。方案名不能含 `:`（路由按最后一个冒号拆 `名字:方案`）、≤ 40 字。
  - 有实例在加载 / 运行的方案不能改名 / 删除（实例以方案名为键）；保存文件 / 方案只改配置，运行中的模型要点「保存并重启」才生效。
  - 保存文件时，与当前不同的引用必须是服务端重新扫描出来的对应类型文件；没改的引用不再校验，所以文件丢失的模型仍可编辑。
  - `UInput type="number"` 的 v-model 给的是数字，表单里统一转回字符串，否则 `.trim()` 抛错会让预览静默不刷新（实测踩到）。
  - Bash 工具里带大量引号的 heredoc + `node -e` 容易整条解析失败；长内容用 Write 工具。
- 下一步：工作包 2-4（Sonnet 5.5，设置页 + 首次启动向导 + 阶段 2 试用）。

---

## 2026-09-30 · 工作包 2-2 · Sonnet 5.5
- 完成：plan 阶段 2 第 4–5 项（模型页 已启用 + 扫描发现）。后端：`server/core/models-admin.ts`（`planEnable` / `missingFiles` / `switchProfile`，纯模块）；接口 `POST /api/scan`、`POST /api/models`（启用，服务端重新扫描，不信任前端元数据）、`POST /api/models/:id/{start,stop,retry,profile}`（都立即返回，进度走 `/api/stream`）。快照的 `models[]` 新增 `files`、`missing`（文件丢失）。前端：`ModelCard`（状态、启动 / 停止 / 重试、方案下拉、文件丢失标红且禁用启动、「排队中」）、`DiscoverPanel`（元数据、重新扫描、启用）、`useModelActions`（统一错误 toast）。
- 验证：`bun test` 209 通过（新增 `models-admin.test.ts` 10 条、`live.test.ts` 1 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server + 假 GGUF（临时数据目录、端口 5099，用完已停、已删）在内置浏览器实测：启动 → 运行中；切方案自动重启；文件丢失标红且启动禁用；扫描（分片不完整、损坏文件、mmproj 候选提示）；一键启用；假进程立即退出 → 失败卡片 + 重试；另一模型运行时启动 → 「排队中」；手机宽度 / 深色。**没测**：真实 llama-server / GPU；`nuxt dev` 下的新接口；停止按钮的 `force`（接口支持，界面没放）。
- 剩余：无。编辑入口、mmproj / draft 下拉、聊天模板选择属于 2-3；模型的删除 / 停用没有入口（不在任务里）。
- 决定 / 坑：
  - 修了 2-1 的遗漏：`handleStream` 的 2 秒 `notify()` 轮询没有真正启动（`poll` 变量从未赋值），在途请求数 / 排队 / 文件丢失都不会推送。已补上并加测试。
  - 切换方案：只要有别的方案在加载 / 运行就 stop 再 start（重启）；已经在跑同一方案则只改 `activeProfile`；只有 failed/crashed 标记时清标记，不自动启动。这与阶段 2 验收「切换后模型自动重启」一致，计划未改。
  - 启用：名字取文件名去掉量化后缀（复用 `aliasOf`），名字 / id 冲突自动加 `-2`；默认方案「默认」，不选 mmproj / draft。
  - `server/api/` 下不要放非路由的 `_xxx.ts` 辅助文件（共享代码放 `server/service/models-api.ts`）。
- 下一步：工作包 2-3（Sonnet 5.5，模型编辑：文件区 / 参数表单 / 命令预览 / 配置方案）。

---

## 2026-09-30 · 工作包 2-1 · Sonnet 5.5
- 完成：plan 阶段 2 第 1–3 项（Nuxt UI + 布局 + 深浅色 + i18n；`/api/stream` + `useLive` composable；总览页）。后端 `server/core/live.ts`（`LiveHub`：状态快照、最近 50 条事件、`handleStream` SSE）；context 新增 `live`，scheduler 事件 / llama.cpp 状态 / 配置文件变化都会触发推送；`/api/state` 与流里的 `snapshot` 是同一份文档。前端 `app/`：`layouts/default.vue`（顶栏 + 侧栏）、基础组件 `AppCard` / `PageHeader` / `StateDot` / `StateBadge`、`composables/useLive.ts` / `useFormat.ts`；页面 总览 + 模型 / 日志 / 设置（占位）。旧配置导入表单挪成 `ImportCard`，暂放设置页。
- 验证：`bun test` 198 通过（新增 `tests/core/live.test.ts` 9 条）；`bun run typecheck`、`bun run build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录，端口 5099，用完已停、已删）在内置浏览器实测：加载中（计时 + 进度条 + 排队）→ 失败（红点 + 中文原因 + 事件）、浅 / 深色、手机宽度、杀服务后出现「实时连接已断开」横幅。**没测**：服务重启后浏览器自动重连（EventSource 自带，没单独验证）；没用真实 llama-server / GPU；`nuxt dev` 下的 `/api/stream` 没跑。
- 剩余：总览页的显存条、速度（prompt/生成 t/s）、真实加载百分比属于 3-2，没做；顶栏只显示模型名 + 状态 + llama.cpp 版本（没有速度，没有更新 / 告警提示）。
- 决定 / 坑：
  - `nuxt.config` 设了 `ssr: false`（纯 SPA；本地控制台不需要 SSR，也避免 hydration 问题）。图标用 `@iconify-json/lucide` 本地打包，不走在线 Iconify。
  - `/api/stream` 在自定义入口里原生处理（和 /v1 一样用 `req.signal`），所以不再需要「内部请求 ID」；开发模式走 `server/api/stream.get.ts`。
  - 在途请求数 / 排队的变化没有事件，`handleStream` 每 2 秒 `notify()` 一次，`LiveHub` 只在快照真的变了才推送。
  - 配色：`app/assets/css/main.css` 用 `--ui-*` 变量覆盖 Nuxt UI 的背景 / 文字 / 边框（深色 #1b1d21 灰底），强调色 `blue`；状态色只用在 `StateDot` / `StateBadge` / 错误文字上。后面的页面复用 `AppCard`，不要另写卡片样式。
  - 总览的「启动 / 停止 / 重试」按钮不在 2-1（模型页 2-2 做）；失败卡片的手动重试入口同理（CR-003 余项）。
- 下一步：工作包 2-2（Sonnet 5.5，模型页：已启用列表 + 扫描发现）。

---

## 2026-09-30 · 阶段 1 第三轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-1-codex-r3.md` 的 CR-001 剩余、CR-013 已修复，各条后写了「处理」。proxy 冷加载流所有结束路径改用有界的 `sendFinal()`（删 `sendError`）；`bounded()` 增加 `activeBoundedWaits()` 计数。store 的 `refresh()` 读到新内容时立即调用 watch 回调；context 的 `openStore` 导出供测试。
- 验证：`bun test` 189 通过（全量 2 次）；`bun run typecheck` 通过；三条新测试在上一版代码上确认失败。Codex 首跑时 scheduler「crash -> crashed」的一次失败在 Windows 上连跑 30 次未复现；已去掉会替换全局 `AbortSignal.prototype` 的测试写法，原因仍未确认。没有 build（用户 start.bat 在运行）。
- 剩余：无（CR-003 余项按用户决定在阶段 2）。
- 决定 / 坑：测试里不要替换全局原型（AbortSignal 等），bun test 同一进程跑所有文件。
- 下一步：Codex 第四轮复审；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 第二轮复审处理 · Opus 5.5
- 完成：`docs/reviews/stage-1-codex-r2.md` 的 CR-001 剩余、CR-004 剩余、CR-012 全部修复，各条后写了「处理」。
  - proxy：新增导出 `bounded(p, signal, ms?)`（每次等待一个 abort 监听，结束即移除）；冷加载转发循环所有等待以 `ac.signal` 为界（客户端断开 + 租约 abort）；模型中止后的最后错误事件最多等 `finalEventTimeoutMs`（默认 5 秒）。
  - store：新增 `refresh()`，`update()` 从磁盘最新内容开始；磁盘文件损坏时抛 StoreError，不覆盖。context 新增 `refresh()`；`commitImport` 先 refresh，失败为 `ImportError('config-invalid')`。
- 验证：`bun test` 186 通过；`bun run typecheck` 通过；proxy 测试连跑 3 次。新的强卸载 / 崩溃任务退出测试、store 手改测试在旧代码上确认失败。没有 build（用户 start.bat 在运行）。
- 剩余：无（CR-003 余项按用户决定在阶段 2）。
- 决定 / 坑：`JsonStore.update()` 现在会先读磁盘；手改文件写坏时，所有写入（包括下载完成写 `llamacpp.current`）都会失败并报错，而不是覆盖掉手改。Windows 上 setTimeout 精度约 15 ms，涉及大量小间隔分块的测试要留足超时。
- 下一步：Codex 第三轮复审；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 审查意见 · 用户决定落地 · Opus 5.5
- 完成：用户决定 CR-010 选 A、CR-011 选 B、CR-003 余项留到阶段 2。CR-010：计划关键决定 5 加导入例外；导入结果 `mmproj` 改为所选文件相对路径，状态页导入结果显示文件名并提示如何更换。CR-011：scheduler 去掉 `servedOk`，自动重载出来的进程再崩溃即 failed，手动 start/retry 后重新计；计划关键决定 22、状态机图、变更记录已同步。审查文件对应条目已更新。
- 验证：`bun test` 178 通过；`bun run typecheck` 通过。没有 build（用户的 start.bat 仍在运行，见下一条）。
- 剩余：CR-003 余项（配置错误的手动恢复入口）→ 阶段 2 模型页 / 失败卡片。等 Codex 复审结论。
- 决定 / 坑：`Lease.release('ok')` 现在只作记录，不影响重载额度。
- 下一步：Codex 复审阶段 1 修复；通过且用户试用确认后开始 2-1。

---

## 2026-09-30 · 阶段 1 审查意见处理 · Opus 5.5
- 完成：逐条核实 `docs/reviews/stage-1-codex.md`，每条后面写了「处理」。已修复 CR-001/002/004/005/006/007/008/009；CR-003 部分修复；CR-010、CR-011 需要用户决定。没有打勾（按指南）。
  - 001 冷加载流：租约随 abort 立即释放，循环的每次写入都和断连竞争。002 runner：先装 exit 处理器再写 pids.json，写失败 → `register-failed` 并杀进程。003 scheduler 新增 `isPrecondition`，`no-runtime` 不再锁 failed。004/005 导入拆成 `readImportSource` + 同步的 `commitImport`（按最新文档规划、失败回滚 settings 和新建模板）。006 备份按（时间戳, 数值序号）排序、命名取最大序号 +1。007 新增 `server/core/origin.ts` + `server/middleware/admin-origin.ts`（/api 写请求：跨来源 403、非 JSON 415）。008 `maxLoaded` 归一化为 1。009 测试注入 platform / 用宿主绝对路径。
- 验证：`bun test` 177 通过；`bun run typecheck` 通过。proxy 测试连跑 3 次通过；新的背压测试在旧代码上失败、新代码通过。`nuxt dev`（临时数据目录、端口 5099，用完已停、已删）实测 origin 中间件：跨来源表单/JSON 403，无来源表单 415，同源 JSON 预览 200。
  - **`bun run build` 失败**：用户的 start.bat 正在运行，`.output` 里 sharp 的 dll 被占用；构建在失败前已经删掉了 `.output` 里其他文件。运行中的实例 /v1、/api 仍可用，状态页静态资源 500。用户关掉 start.bat 重开会自动重新构建。本次 build 没有验证。
  - 没在 macOS/Linux 跑测试（CR-009 只在 Windows 验证）；没做 GPU 真机测试。
- 剩余：CR-003 的其余配置错误（file-missing 等）改配置后仍要重启才能恢复，手动重试入口在阶段 2（模型页、失败卡片）。CR-010（导入自动配 mmproj）、CR-011（崩溃重载额度的重置条件）等用户决定。
- 决定 / 坑：
  - Bun：在 `req.signal` 的 abort 回调里同步 `writer.abort()` SSE 的 TransformStream，Bun 服务器读响应体时会报未处理的拒绝；改为让等待和断连 Promise 竞争。
  - 手改文件后 100 ms 防抖内的任何保存会覆盖手改（store 通用限制）；origin 检查不防 DNS 重绑定。
  - 用户的 start.bat 在跑时别 `bun run build`，会删掉 `.output`。
- 下一步：用户决定 CR-010 / CR-011（及 CR-003 余项），重启 start.bat 试用，确认后开始 2-1。

## 2026-09-30 · 工作包 1-6 · Opus 5.5
- 完成：plan 阶段 1 剩余三项（llama.cpp 初始获取、start.bat、真机冒烟）打勾，阶段 1 全部完成。修复：`llamacpp.ts` 新增 `pickCudaVersion`（官方已从 CUDA 13.3 换成 13.4，原来写死精确版本导致 `asset-missing`）；`start.bat` 的 `>/dev/null` 改 `>nul`、运行行加 `call`（bun 是 bun.cmd）、工作区改回 CRLF。新增测试 `tests/platform/start-bat.test.ts`、llamacpp 两条。
- 验证：`bun test` 159 通过；`typecheck`、`build` 通过。真机（仓库 `data/`，RTX 5090，b11146）逐条验收，全部通过：
  - 真实下载 bin 150 MB + cudart 423 MB，SHA-256 校验、解压、自动设为 current。网速约 300 KB/s，共约 25 分钟。
  - 导入旧 swap-config：3 个模型，名字与旧别名一致。
  - 冷加载流式：约 46–49 秒，每 15 秒一次 `: loading` 心跳，然后逐块输出。
  - 切换：draining → unloading → stopped → loading → ready，只剩一个 llama-server。
  - 排队：长回复在途时另一客户端要别的模型，旧模型 draining（inflight 1），长回复结束后 0.2 秒才开始卸载；非流式请求等了 130 秒没断。
  - 图片：日志 `2000x1000 png 59KB -> 896x448 jpeg 11KB`，回答正确；没有 mmproj 的临时模型收到中文 400，且不触发加载（临时条目已删）。
  - 关 start.bat 窗口 3.8 秒内全部退出、pids.json 清空。强杀 bun 时 llama-server 随之退出；手造真实残留后启动 → `killed 1`。
  - **没测**：酒馆本身（用脚本模拟 OpenAI 流式请求，酒馆留给用户在关口试用）。
- 剩余：无。
- 决定 / 坑：
  - `cudaRuntime` 语义改为「首选版本」：精确版本没有时，选同一主版本里最新的次版本（必须同时有 cudart），不会跨主版本。settings 里的值不会被改写。**需要用户知悉**（已写进变更记录）。
  - Windows 下文件还开着时，目录列表显示的大小会一直是 0，不代表下载卡住。
  - 这台机器 PowerShell 的 `bun` 是 `bun.ps1/bun.cmd`，`Start-Process` 要用真实的 bun.exe 路径。控制台窗口句柄要按标题 `llama-web` 找（conhost 的 MainWindowHandle 为 0）。
  - 1-5 留下的两个待确认点（导入时 mmproj 自动配对、`--jinja` 不触发重复警告）仍待用户确认。
- 下一步：阶段关口 1（用户试用 + Codex 审查），确认后才开始 2-1。

## 2026-09-30 · 工作包 1-5 · Sonnet 5.5
- 完成：plan 阶段 1 第 13 项（旧配置导入）、第 15 项（最简状态页）。`server/core/importer.ts`（+ `POST /api/import`，`{ path, dryRun? }`）、`server/core/llamacpp.ts`（版本目录扫描 + 初始下载）、`GET /api/state`、`app/pages/index.vue`（状态 + 导入表单）、`start.bat`、`.gitattributes`（bat 强制 CRLF）。context 新增 `updateSettings / updateModels / getRuntimeStatus`（自己写盘不会触发文件监听，必须走这两个）。
- 验证：`bun test` 155 通过；`bun run typecheck`、`bun run build` 通过。构建产物经 `start.bat` 启动（临时数据目录，端口 5099，用完已删）：`/api/state`、页面 200；对旧 swap-config.json 做预览和真实导入（写入临时目录）：3 个模型、mmproj 和 `-md` 草稿模型配对正确、聊天模板复制成功、key/域名未导入；错误路径返回中文 400。**没有**实际下载 llama.cpp（未经用户同意不下几百 MB），**没有**测关闭 start.bat 窗口，没用 GPU。
- 剩余（所以这两项没打勾）：
  - 「llama.cpp 初始获取」：下载 / 校验 / 解压逻辑只用假网络和假解压测过，真实的 GitHub 资产格式只核对了 API 返回（`nightly-tag.txt`、`digest` 字段存在）。1-6 真机时请用户同意后跑一次真实下载。
  - 「start.bat」：能构建并启动；「关窗口即停止」留给 1-6 实测。
- 决定 / 坑：
  - **需要用户确认**：导入时 mmproj 按目录自动配对（沿用旧生成器：优先 BF16/F16/F32），与关键决定 5「mmproj 默认不选」不同。理由：否则旧配置导入后图片功能全部失效。手动启用模型仍按决定 5。
  - 旧配置里全局没写的参数视为「不传」（旧生成器就是这样），所以导入后 `defaults.batchSize` 等可能为 null。全局默认只在**首次导入**（models.json 为空）时覆盖；再次导入保留现有默认值，各模型的覆盖项按当时生效的默认值重新计算。已存在的同名模型跳过。
  - 旧 `-md "<路径>"` 在模型目录内且扫描到时转成 `draft` 字段并从额外参数移除；否则留在额外参数并警告。旧的 `chat_template`（名字）追加为 `--chat-template <名>`；`chat_template_file` 复制到 `data/templates/`，同名不同内容时改名 `<名>-imported`。`public` 段（域名、隧道、key）整体不导入。
  - 初始下载只在 `data/runtime` 里没有任何可用版本、且 `llamacpp.autoUpdate` 为 true 时发生；有版本但 `llamacpp.current` 为空或失效时自动采用最新已装版本。后台执行，不阻塞启动；下载前请求会得到 `no-runtime`。状态见 `/api/state` 的 `llamacpp.runtime`。解压用系统 `tar.exe`（Windows 自带 bsdtar），没加依赖。下载先到 `.tmp-*` 目录，完整后整体改名，失败不留半个版本。摘要缺失一律拒绝安装。
  - 这台机器上启动子进程很慢（约 2.5 秒），涉及 spawn 的测试要给足超时。`cmd /c start.bat` 要写成 `.\start.bat`。
  - 状态页只轮询 `/api/state`（每 2 秒），SSE 在 2-1。
- 下一步：工作包 1-6（Opus 5.5，阶段 1 验收）。真机测试前先告诉用户（占用 GPU、需先关旧 llama-swap、需同意下载 llama.cpp）。

## 2026-09-30 · 工作包 1-4 · Opus 5.5
- 完成：plan 阶段 1 第 10–12 项 +「单元测试」项。`server/core/` 新增 config.ts（settings / models 结构、默认值、补全）、routing.ts、launch.ts、proxy.ts、i18n.ts、preprocess/（index + image）；`server/service/context.ts` 单例接线；自定义 Bun 入口 `server/entry.ts`；开发模式路由 `server/routes/{v1,upstream}/[...path].ts`；插件 `plugins/residue.ts` 换成 `plugins/app.ts`。错误文案在 i18n `api` / `loadError`。
- 验证：`bun test` 133 通过（全量 2 次，proxy 3 次）；`typecheck`、`build` 通过。构建产物 + 编译成 exe 的假 llama-server（临时数据目录，用完已删）：/v1/models、加载中心跳后逐 chunk 输出、长流式结束后才切换、非流式静默等 15 秒不断开、断开后切换、图片 2000x1000 png → 896x448 jpeg、无 mmproj 中文 400、/upstream、手改 settings.json 热重载。`nuxt dev` 下同样测了流式 / 断开 / 切换 / upstream。**没用真实 llama-server 和 GPU**，留给 1-6。
- 剩余：无。未做：给 Nitro 处理函数传 signal / IP 的内部请求 ID（2-1 的 /api/stream 需要时再做）；入口里 SIGINT / SIGHUP 优雅退出的代码没测过（1-6 测 start.bat）。
- 决定 / 坑：
  - **Bun 1.3.14 会崩**：在响应流 `cancel` 里对上游 fetch body 调 `reader.cancel()` 会段错误。只用 fetch 的 AbortSignal 取消上游。以后写流式代码别用它。
  - `nitro.entry` 放在 `$production` 下：开发模式下它也会替换 dev worker 入口（Node 里 `Bun is not defined`）。
  - 流式请求、目标没 ready：立刻回 200 SSE，先发 `: loading`，之后每 heartbeatSec 一次；加载失败发 `data: {"error":…}` 再关流。目标已 ready：透传上游状态码和头。心跳百分比预留了 `progressOf`（3-2 接）。
  - 租约释放：上游结束 / 出错 / 客户端断开（req.signal 或响应流 cancel）都会 release；中止上游就立刻释放，不等下一次 pull（dev 模式下没人 pull）。
  - model 解析：整串能匹配就用整串（名字里可以有 `:`），否则按最后一个 `:` 拆；依次按 name、id、忽略大小写的 name 找。没有 model 字段：ready 的模型，其次 loading 的，否则 400。
  - 转发时去掉 authorization、accept-encoding 和逐跳头。/upstream 不会触发加载，只转发 ready 的模型；`/upstream/x` 308 到 `/upstream/x/`。llama-server 自带网页用绝对路径的资源在前缀下能不能用还没验证。
  - 请求体上限 100 MB（代码常量 `MAX_BODY_BYTES`，没加设置项）。图片只处理 base64 data URI，远程 URL 不动；小于 maxEdge 且格式相同的原样转发。按方案覆盖用 `profile.preprocess.image`（计划结构里只有方案级）。压缩前后尺寸目前只打到控制台。
  - 手改设置：portRange / drainTimeoutSec / heartbeatSec / 启动参数下次使用时生效；maxLoaded、server.host/port 要重启。设置文件损坏时用默认值并打错误日志，不覆盖文件。
  - `profile.chatTemplate` = `data/templates/` 下的文件名。`llamacpp.current` 为空 → 加载失败 `no-runtime`，1-5 初始获取后要写入它。
- 下一步：工作包 1-5（Sonnet 5.5）。

## 2026-09-30 · 工作包 1-3 · Opus 5.5
- 完成：plan 阶段 1 第 7–9 项。`server/core/runner.ts`（Runner / RunningProcess / PidRegistry / LoadError）、`residue.ts`（cleanupResidue、runStartupCleanup）、`scheduler.ts`；`server/plugins/residue.ts` 启动时跑清理。测试 `tests/core/{scheduler,runner,residue}.test.ts`，假 llama-server `tests/fixtures/fake-llama-server.ts`。
- 验证：`bun test` 89 通过（连跑 3 次）；`bun run typecheck` 通过；`bun run build` 通过。真机：真实 llama-server b10809 + 27B Q4（`-c 4096`），scheduler → runner 加载 37 秒、/health 200、对话 200；停止 3.6 秒，进程树（含其子进程）全灭、端口释放、pids.json 清空；残留清理杀掉运行目录下的真实进程、放过目录外的。临时脚本在仓库外，已删除。
- 剩余：无。「单元测试」项仍未打勾（路由解析在 1-4）。强杀 llama-web 后的残留场景留到 1-6。
- 决定 / 坑：
  - runner 用 `node:child_process`（不用 Bun.spawn），这样 `nuxt dev` 的 Node 服务器下也能用。停止 = `taskkill /T /F`，没有温和退出。`'exit'` 后等 `'close'`（最多 1 秒）再结算，保证失败时的最后几行日志完整。
  - runner 本身不懂 settings：`start({ exe, args: port => [...], tag, loadTimeoutMs, onLine })`，args 由调用方用 args.ts 按端口生成。端口按范围从小到大找第一个能 listen 的，同进程内已分配的端口跳过。
  - scheduler 通过注入的 `launch(target) => ModelProcess` 工作（RunningProcess 结构上符合）。目标 = 模型 + 方案；换方案 = 另一个目标 = 重启。所有加载经一个 FIFO 队列串行执行；ready 的目标直接给 lease。
  - 请求必须 `lease.release()`；转发正常结束时传 `'ok'`。lease.signal 在强制卸载 / 崩溃时 abort，1-4 的转发要监听它取消上游。
  - **需要用户确认的细节**：「崩溃后最多自动重载一次」实现为：崩溃 → crashed，下一个请求自动重载；重载失败或重载后还没有任何请求 `release('ok')` 就再次崩溃 → failed；重载后成功服务过请求，之后再崩溃仍可再自动重载一次。手动启动不算自动重载。
  - 手动 `stop(modelId)`：拒绝排队请求（code `stopped`）、中止加载中的进程、ready 的先 drain（`force` 直接杀）、清掉 failed。draining 中的模型不接新请求，新请求排到队尾。
  - 等待中的请求 abort 后移除；未开始的切换没人等就丢弃；已开始的切换会做完。
  - 1-4 接线：先 `await runStartupCleanup(dataDir)` 再建 scheduler；退出时 `scheduler.shutdown()`。错误都是 code（SchedulerError / LoadError），中文文案还没加进 i18n。
- 下一步：工作包 1-4（Opus 5.5）。

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
