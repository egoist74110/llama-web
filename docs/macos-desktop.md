# macOS desktop（Apple Silicon，未签名测试包）

状态（2026-10-05）：只出 **arm64** 的 DMG。用户 2026-10-05 要求与 Windows 同版本（0.1.0-beta.7）一起发：先跑 Windows 工作流创建草稿 Release，再跑本工作流并勾选 `attach_to_draft`，把 DMG 挂到同一个**草稿**并把 DMG 追加进 `SHA256SUMS`；公开草稿由维护者核对下载包后手动执行。没有 Apple 开发者证书：应用只做了 ad-hoc 签名，**没有公证**，所以首次打开 macOS 会警告，不能说“无提示安装”。Intel Mac 不构建、不用 Rosetta 代替验证。Mac 包日后与 Windows 同版本一起发，那是单独的工作包。

## 构建

只在原生 Apple Silicon 上构建，不交叉编译，不复用 Windows 的 `node_modules`。需要 Bun 1.3.14、Rust（版本见 `rust-toolchain.toml`）、Xcode 命令行工具。

```bash
bun install --frozen-lockfile
bun run desktop:build:mac     # = desktop:prepare + tauri build --bundles dmg
```

- `desktop/prepare.ts` 在 macOS arm64 上与 Windows 走同一条隔离工作树流程：冻结安装、`nuxt build`、把完整 `.output`、**官方 Bun（复制运行脚本的那份 Bun，要求版本等于 1.3.14）**、数据导入助手和许可汇总复制到 `src-tauri/resources/`，`versions.json` 的 `target` 为 `macos-arm64`。sharp 来自 `@img/sharp-darwin-arm64` 与 `@img/sharp-libvips-darwin-arm64`（`.output` 里已带）。
- `src-tauri/tauri.macos.conf.json` 只在 macOS 上被 Tauri 合并：目标 `app` / `dmg`、`icons/icon.icns`、最低系统 13.0（Bun 的要求）、`signingIdentity: "-"`（ad-hoc）。Windows 的 `tauri.conf.json` 没有改。
- `icons/icon.icns` 由仓库里 32×32 的 `icon.png` 放大而来，**只是占位图标，会偏糊**；正式图标需要一张大图。
- 产物：`src-tauri/target/release/bundle/dmg/llama-web_<版本>_aarch64.dmg`。

## GitHub Actions：`macOS arm64 build (artifact only)`

`.github/workflows/release-macos.yml`，手动触发（输入版本，必须等于 `package.json`；可选 `attach_to_draft`），`macos-15`（arm64）。**本身不创建 Release、不打 tag**；只有勾选 `attach_to_draft` 时，最后一步才往**已存在的草稿** `v<版本>` 上传（草稿必须已有 Windows 安装包和 `SHA256SUMS`；已公开的 Release 或已有同名 DMG 会直接拒绝；Mac 的许可汇总以 `THIRD-PARTY-NOTICES-macos.txt` 上传，不覆盖 Windows 的）。工作流 `contents: write` 只给这一步用。步骤：冻结安装 → `bun test` → typecheck → 构建 DMG → `cargo test` → `desktop/check-package.ts`（DMG）→ 在从 DMG 取出的 `.app` 里用**包内的 Bun** 跑 JIT、sharp、起服务（隔离数据目录）并下载 / 解压 / 执行真实 llama.cpp 做 `--version` → 汇集产物并作为 workflow artifact 上传（保留 14 天）：

- `llama-web_<版本>_macos-arm64.dmg`
- `llama-web_<版本>_macos-arm64.dmg.sha256`
- `llama-web-<版本>-macos-arm64-manifest.json`（提交、大小、SHA-256、签名状态、工具链）
- `THIRD-PARTY-NOTICES.txt`、`LICENSE.txt`

版本号只来自 `package.json`（`tauri.conf.json` 引用它，Info.plist 的版本由此而来）。产物文件名里的 `macos-arm64` 后缀是为日后应用内更新按平台选资产预留的；Release 页合并发布时再统一 `SHA256SUMS`。

## 包内容检查（`desktop/check-package.ts`）

`bun desktop/check-package.ts <x.dmg | x.app>`（DMG 用 `hdiutil` 只读挂载，检查完卸载）。除 Windows 已有的 allowlist / 拒绝项 / 本机路径扫描外，对 `.app` 额外要求：

- `.app` 里只允许 `Info.plist`、`PkgInfo`、主程序、图标、`_CodeSignature`，其余位于 `Contents/Resources/resources/`（沿用 allowlist，Bun 文件名是 `bun`）；DMG 根目录只允许 `llama-web.app`、`Applications`、Finder 元数据。
- 内置 Bun 是单架构 **arm64** Mach-O 且可执行；sharp 的 `.node` 与 libvips 的 `.dylib` 在位且是 arm64；没有 `.exe` / `.dll` / win32 / linux / darwin-x64 的原生文件。
- `versions.json` 的目标是 `macos-arm64`，`bunSha256` 与内置 Bun 一致，`Info.plist` 版本与 `versions.json` 一致。
- 在 macOS 上还运行 `codesign --verify --deep --strict`，并确认内置 Bun 自己的签名仍然有效、仍带 `allow-jit` 权限。

Windows 模式（`.exe` 安装包、`resources` 目录）的逻辑与允许清单没有变，`tests/platform/check-package.test.ts` 里有回归测试（Windows 允许 `bun.exe` 而拒绝 `bun`）。

## 签名、entitlements 与能不能执行（本机 arm64 Mac 实测，2026-10-05）

| 项 | 结果 |
|---|---|
| 官方 Bun 1.3.14 自带签名 | Developer ID（Jarred Sumner）、hardened runtime，权限含 `allow-jit`、`allow-unsigned-executable-memory`、`disable-executable-page-protection`、`disable-library-validation`、`allow-dyld-environment-variables` |
| Tauri 对应用的签名 | 主程序与 `.app` 做 ad-hoc 签名，带 `runtime`（hardened runtime）标志；**资源目录里的文件不会被重新签名**，内置 Bun 保持官方签名与权限（`codesign --verify` 通过，字节与官方相同） |
| 为什么不要再手动签 Bun | 用 ad-hoc 重签会丢掉上面的权限，开了 hardened runtime 的 Bun 第一次 JIT 就会崩。所以**不加额外 entitlements 文件，也不 `--deep` 重签资源** |
| sharp / libvips | 随 npm 包带的 `.node` 与 `.dylib` 是 linker 生成的 ad-hoc 签名；Bun 带 `disable-library-validation`，可加载 |
| 从 DMG 取出的 `.app` 内 | 内置 Bun 的 JIT 循环、sharp 缩放 JPEG（libvips 8.18.7）、起服务并返回页面 200、`/v1/models` 空列表，均成功 |
| 运行时下载的 llama.cpp | 由应用自己下载（无隔离属性）；CI 已用源码版 Bun 验证 `llama-server --version`，工作流里再用**包内 Bun** 验证一次（见上；runner 上已通过，run 37270349450） |
| 模拟隔离属性（`com.apple.quarantine`） | 给 `.app` 根目录写“未批准”的隔离标记后，包内 Bun 被系统直接杀掉（退出码 137）；写“用户已批准”标记（Open Anyway 之后的状态）或去掉标记则正常。这是**手工模拟**，用户在 Mac 上实际走一遍流程后才能下结论 |

未验证：整个应用窗口在真实“下载 → 挂载 DMG → 拖入 Applications → 首次打开”流程里的表现；Metal 推理；模型加载；退出后进程组清理（5-1 的 POSIX 逻辑只有构造测试 + CI）；不同 macOS 版本（本机是 macOS 27，工作流跑在 macos-15）。

## 首次打开（没有证书时用户要做的事）

> 2026-10-05 用户在一台 Apple Silicon Mac 上用下面第 3 步（隐私与安全性 → 仍要打开）实测可用。右键 → 打开 没有验证，新版 macOS 起系统收紧了这种绕过方式，不保证有效；第 4 步的 `xattr` 命令未单独验证。

1. 打开 DMG，把 `llama-web` 拖进“应用程序”。
2. 双击打开，系统会提示无法验证开发者，先点“完成 / 取消”。
3. 打开“系统设置 → 隐私与安全性”，拉到底部，找到“已阻止使用 llama-web”，点“仍要打开”，再确认。之后可以正常打开。
4. 如果提示“已损坏”或仍被拦截：确认文件来自你信任的来源并核对 `.sha256` 后，可以在终端去掉隔离属性：

```bash
xattr -dr com.apple.quarantine /Applications/llama-web.app
```

这会让系统不再对这个应用做首次打开检查，只对你自己核对过来源的包执行。

## 更新路径（初步，本包不实现）

- 现在：Mac 版没有应用内更新：服务入口只在 Windows 上注册安装钩子（`server/entry.ts`），Mac 上「关于与更新」只显示新版本与发布页链接，不会下载 `.exe`（`src-tauri/src/update.rs` 在非 Windows 上也是空实现）。更新方式 = 下载新版本的 DMG，用它替换“应用程序”里的旧应用；数据在用户目录，不会丢。
- 之后：Release 页合并 Windows / Mac 资产与统一 `SHA256SUMS`，应用内更新按 `macos-arm64` 后缀选资产。未签名应用在原位替换时会遇到隔离属性和权限问题，需要单独设计，不在本包。
- 有证书之后：Developer ID 签名 + 公证 + staple，并重新评估 hardened runtime 与内置 Bun 的权限组合。
