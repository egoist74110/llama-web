// All user-facing UI strings live here. Components must not hard-code Chinese text.
// `{name}` placeholders are filled by `fmt()` in server/core/i18n.ts.
export default {
  app: {
    title: 'llama-web',
    subtitle: '本地 LLM 控制台',
  },
  // Error messages returned by /v1/* and /upstream/* (OpenAI error format).
  api: {
    modelNotFound: '找不到模型「{name}」。可用的模型名见 GET /v1/models。',
    profileNotFound: '模型「{model}」没有名为「{profile}」的配置方案。',
    noModel: '请求里没有 model 字段，而且当前没有正在运行的模型。',
    imageWithoutMmproj: '模型「{model}」没有配置 mmproj（视觉投影文件），不能处理图片。请在模型设置里选择 mmproj，或去掉图片后重试。',
    bodyTooLarge: '请求体超过上限（{limit} MB）。',
    badJson: '请求体不是有效的 JSON。',
    loadFailed: '模型「{model}」加载失败：{reason}。请查看日志，处理后手动重试。',
    modelStopped: '模型「{model}」已被手动停止，请求已取消。',
    shuttingDown: 'llama-web 正在关闭。',
    upstreamUnreachable: '无法连接到模型「{model}」的 llama-server 进程：{detail}',
    interrupted: '模型「{model}」已卸载或意外退出，请求被中断。',
    notRunning: '模型「{model}」当前没有运行。/upstream 只转发到已经在运行的模型，不会自动加载。',
    notFound: '没有这个接口：{path}',
    preprocessFailed: '请求预处理失败：{detail}',
  },
  // Short load-failure reasons, used inside api.loadFailed.
  loadError: {
    'no-port': '端口范围内没有空闲端口',
    'spawn-failed': '无法启动 llama-server 可执行文件',
    'exited': 'llama-server 在就绪前退出了',
    'timeout': '加载超时',
    'aborted': '加载被中止',
    'crashed': '模型进程意外退出，自动重载后仍然失败',
    'model-missing': '模型配置不存在',
    'profile-missing': '配置方案不存在',
    'file-missing': '模型文件不存在或目录未配置',
    'no-runtime': '没有可用的 llama.cpp（data/runtime 下找不到 llama-server）',
    'bad-args': '启动参数有错误',
    'unknown': '未知错误',
  },
} as const
