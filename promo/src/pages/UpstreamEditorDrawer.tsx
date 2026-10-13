import React from 'react';
import {Check, Copy, PlugZap} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Btn, Chip, Drawer, Input, Switch} from '../ui/lw';

// Replica of app/components/UpstreamEditor.vue ("添加外部服务" slide-over drawer).
// Native app coordinates: 1440 x 810.
// Pure component: every visual state comes from props.

export const UPSTREAM_EDITOR_LAYOUT = {
  drawer: {x: 864, y: 0, w: 576, h: 810},
  nameInput: {x: 1130, y: 148},
  urlInput: {x: 1130, y: 240},
  apiKeyInput: {x: 1130, y: 322},
  startCommandInput: {x: 1130, y: 404},
  localSwitch: {x: 1402, y: 486},
  exclusiveSwitch: {x: 1402, y: 532},
  testBtn: {x: 914, y: 588},
  guideSummary: {x: 986, y: 654},
  copyPromptBtn: {x: 934, y: 620},
  saveBtn: {x: 1384, y: 784},
  cancelBtn: {x: 1315, y: 784},
} as const;

const AI_PROMPT_TEXT = `我要在 llama-web 里给一个本地 AI 服务配置「启动命令」。请按下面的规则帮我写一条命令。
- 系统：（Windows 或 macOS）
- 项目所在的文件夹：（路径）
- 我平时手动启动它的方式：（例如双击某个脚本，或在终端里运行什么命令）

规则（必须全部遵守）：
1. 只写一行命令：先是程序的完整路径，后面是参数，用空格分隔；路径含空格时用英文双引号括起来。所有路径都写绝对路径，不要用相对路径、~、%VAR%、$VAR。
2. llama-web 不经过 shell 执行这条命令：不能用管道、&&、;、重定向、cd、set / export、通配符。需要这些时，把它们写进一个脚本文件，命令里只调用这个脚本（Windows 用 cmd.exe /c "脚本路径" 或 powershell.exe -File "脚本路径"，macOS 用 /bin/bash "脚本路径"），并把脚本的完整内容也给我。
3. 优先让命令直接运行服务本身（例如直接调用虚拟环境里的 python.exe 加服务脚本），让服务进程一直在前台运行。不要写「启动一个隐藏的后台子进程然后自己退出」的启动器；如果我原来的方式就是这样的启动器，请改成直接运行服务的命令。
4. 不要编造路径、文件名或参数；不确定的地方直接问我，不要猜。
5. 最后告诉我：服务启动后，它的 OpenAI 兼容接口地址（必须包含 /v1，例如 http://127.0.0.1:端口/v1），我要填到 llama-web 的「地址」里。如果端口是启动时动态选择的，请告诉我去哪里能看到实际端口。`;

export type UpstreamEditorDrawerProps = {
  open?: boolean;
  enter?: number;
  title?: string;
  name?: string;
  baseUrl?: string;
  apiKeyMasked?: boolean;
  startCommand?: string;
  local?: boolean;
  exclusive?: boolean;
  tested?: boolean;
  testedModel?: string;
  guideOpen?: boolean;
  copied?: boolean;
  scrollY?: number;

  // Pressed feedback (0..1)
  nameInputPressed?: number;
  urlInputPressed?: number;
  startCommandPressed?: number;
  testPressed?: number;
  guideSummaryPressed?: number;
  copyPressed?: number;
  savePressed?: number;
  cancelPressed?: number;
};

export const UpstreamEditorDrawer: React.FC<UpstreamEditorDrawerProps> = ({
  open = true,
  enter = 1,
  title = '添加外部服务',
  name = '',
  baseUrl = '',
  apiKeyMasked = false,
  startCommand = '',
  local = true,
  exclusive = true,
  tested = false,
  testedModel = 'Strata-qwen3-32b',
  guideOpen = false,
  copied = false,
  scrollY = 0,
  nameInputPressed = 0,
  urlInputPressed = 0,
  startCommandPressed = 0,
  testPressed = 0,
  guideSummaryPressed = 0,
  copyPressed = 0,
  savePressed = 0,
  cancelPressed = 0,
}) => {
  if (!open || enter <= 0.001) return null;

  return (
    <Drawer
      width={576}
      enter={enter}
      title={title}
      description="外部服务必须提供 OpenAI 兼容的接口。保存后可以点「测试连接」读取它的模型列表。"
      footer={
        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
          <Btn variant="ghost" label="取消" size="sm" pressed={cancelPressed} />
          <Btn variant="primary" icon={Check} label="保存" size="sm" pressed={savePressed} />
        </div>
      }
    >
      <div
        style={{
          padding: '16px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          transform: `translateY(${-scrollY}px)`,
        }}
      >
        {/* 1. 名称 */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>名称</div>
          <Input
            placeholder="例如 Strata"
            focused={nameInputPressed > 0}
            height={32}
          >
            {name ? <span>{name}</span> : null}
          </Input>
          <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            同时是模型名的前缀：客户端用「名称-模型id」调用。不能含空格、减号（-）、冒号、斜杠，最多 24 个字符。
          </div>
        </div>

        {/* 2. 地址 */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>地址</div>
          <Input
            mono
            placeholder="http://127.0.0.1:8080/v1"
            focused={urlInputPressed > 0}
            height={32}
          >
            {baseUrl ? <span>{baseUrl}</span> : null}
          </Input>
          <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            含 /v1 的完整地址，不要带用户名或问号参数。
          </div>
        </div>

        {/* 3. API key (可选) */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>API key（可选）</div>
          <Input placeholder="没有就留空" height={32}>
            {apiKeyMasked ? <span style={{letterSpacing: 2}}>••••••••••••</span> : null}
          </Input>
          <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            客户端看不到它；llama-web 转发时用它代替客户端的 key。
          </div>
        </div>

        {/* 4. 启动命令 (可选) */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>启动命令（可选）</div>
          <Input
            mono
            placeholder='/bin/zsh "/Users/me/path/start.sh"'
            focused={startCommandPressed > 0}
            height={32}
          >
            {startCommand ? <span>{startCommand}</span> : null}
          </Input>
          <div style={{fontSize: 11, color: COLORS.textFaint, lineHeight: 1.35}}>
            服务不在线时，可以在「接入」页点「启动」来运行它。只能写一条命令（引号要成对）。
          </div>
        </div>

        {/* 5. 在本机运行 & 独占本机 开关 */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
            <div style={{minWidth: 0}}>
              <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>在本机运行</div>
              <div style={{fontSize: 11, color: COLORS.textFaint}}>这个服务跑在这台电脑上，会和本地模型抢显存和内存。</div>
            </div>
            <Switch on={local} />
          </div>

          {local ? (
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
              <div style={{minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>独占本机</div>
                <div style={{fontSize: 11, color: COLORS.textFaint}}>它运行时，llama-web 会卸载本地模型，避免同时占用。</div>
              </div>
              <Switch on={exclusive} />
            </div>
          ) : null}
        </div>

        {/* 6. 测试连接按钮与测试结果 */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10}}>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <Btn
              variant="outline"
              icon={PlugZap}
              label="测试连接"
              size="xs"
              pressed={testPressed}
            />
            {tested ? (
              <span style={{fontSize: 12, color: COLORS.ok}}>连接正常，找到 1 个模型</span>
            ) : null}
          </div>
          {tested ? (
            <div style={{display: 'flex', alignItems: 'center', gap: 6, marginTop: 2}}>
              <span style={{fontSize: 12, color: COLORS.textMuted}}>可用模型：</span>
              <Chip mono accent>{testedModel}</Chip>
            </div>
          ) : null}
        </div>

        {/* 7. 不知道怎么写启动命令？ 折叠区 */}
        <div
          style={{
            borderRadius: 10,
            border: `1px solid ${COLORS.border}`,
            padding: '10px 14px',
            fontSize: 13,
            background: COLORS.surfaceInset,
            marginTop: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontWeight: 500,
              color: COLORS.text,
              cursor: 'pointer',
              transform: `scale(${1 - 0.02 * guideSummaryPressed})`,
            }}
          >
            <span>不知道怎么写启动命令？</span>
            <span style={{fontSize: 12, color: COLORS.textFaint}}>
              {guideOpen ? '▲ 折叠' : '▼ 展开教程'}
            </span>
          </div>

          {guideOpen ? (
            <div style={{display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, fontSize: 12, color: COLORS.textMuted}}>
              <p style={{margin: 0, lineHeight: 1.4}}>
                写一条「运行后能把服务拉起来」的命令就行。服务一直在后台跑，或者脚本启动服务后自己退出，都可以。
              </p>

              <div>
                <div style={{fontWeight: 500, color: COLORS.text, marginBottom: 4}}>macOS 示例</div>
                <div style={{fontFamily: FONT.mono, fontSize: 11, color: COLORS.textFaint, lineHeight: 1.4}}>
                  /bin/zsh "/Users/me/path/start.sh"
                </div>
              </div>

              <div>
                <div style={{fontWeight: 500, color: COLORS.text, marginBottom: 4}}>让 AI 助手帮你写</div>
                <div style={{marginBottom: 6, lineHeight: 1.4}}>
                  把下面这段话复制给你常用的 AI 助手（Claude、ChatGPT 等），补上信息即可得到命令。
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: COLORS.surfaceRaised,
                    border: `1px solid ${COLORS.border}`,
                    fontFamily: FONT.sans,
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: COLORS.text,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 120,
                    overflow: 'hidden',
                  }}
                >
                  {AI_PROMPT_TEXT}
                </pre>
                <div style={{marginTop: 8}}>
                  <Btn
                    variant="outline"
                    icon={copied ? Check : Copy}
                    label={copied ? '已复制' : '复制这段话'}
                    size="xs"
                    pressed={copyPressed}
                    style={{color: copied ? COLORS.ok : undefined}}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
};
