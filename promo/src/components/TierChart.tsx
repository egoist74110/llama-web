import React from 'react';
import {CheckCircle2, Cpu, Globe2, Terminal} from 'lucide-react';
import {COLORS, FONT, RADIUS} from '../theme';
import {Chip, LW} from '../ui/lw';

// Replica of SCRIPT.md chapter 6 scene 4: Three-tier comparison chart (三档对比图).
// Native product palette & LW component styling. Pure component driven by props.

export type TierChartProps = {
  col1Enter?: number; // 0..1 for "原生管理"
  col2Enter?: number; // 0..1 for "启动 · 停止 · 转发"
  col3Enter?: number; // 0..1 for "仅转发"
  style?: React.CSSProperties;
};

export const TierChart: React.FC<TierChartProps> = ({
  col1Enter = 1,
  col2Enter = 1,
  col3Enter = 1,
  style,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        maxWidth: 1140,
        margin: '0 auto',
        padding: '24px 0',
        ...style,
      }}
    >
      {/* Title header */}
      <div style={{textAlign: 'center', marginBottom: 28}}>
        <div style={{display: 'inline-flex', marginBottom: 8}}>
          <Chip accent>有限管理 · 边界清晰</Chip>
        </div>
        <div style={{fontSize: 26, fontWeight: 700, color: COLORS.text, letterSpacing: '-0.02em'}}>
          支持它们的 API，不等于接管它们
        </div>
        <div style={{fontSize: 14, color: COLORS.textMuted, marginTop: 4}}>
          llama.cpp 原生管理 · 其他引擎只做启动、停止和转发
        </div>
      </div>

      {/* 3 Columns */}
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, width: '100%'}}>
        {/* Column 1: 原生管理 */}
        <div
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.accent}`,
            borderRadius: RADIUS.card,
            padding: '22px 20px',
            boxShadow: `0 0 0 1px ${COLORS.accentSoft}, ${LW.shadow}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            opacity: col1Enter,
            transform: `translateY(${(1 - col1Enter) * 24}px) scale(${0.96 + 0.04 * col1Enter})`,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <Chip accent icon={Cpu}>原生管理</Chip>
            <span style={{fontSize: 11, color: COLORS.accentText, fontWeight: 500}}>唯一原生引擎</span>
          </div>

          <div>
            <div style={{fontSize: 17, fontWeight: 700, color: COLORS.text}}>
              llama.cpp 官方版和变体
            </div>
            <div style={{fontSize: 12, color: COLORS.textMuted, marginTop: 3}}>
              深度进程管理 · 完整生命周期托管
            </div>
          </div>

          <div style={{display: 'flex', flexDirection: 'column', gap: 9, flex: 1}}>
            {[
              '官方版自动检测新版，保留 2 版随时回退',
              '支持社区分支与手动添加变体',
              '上下文、思考、显存预估可视化调参',
              '多配置方案保存与请求自动排队切换',
            ].map((item, idx) => (
              <div key={idx} style={{display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: COLORS.text, lineHeight: 1.4}}>
                <CheckCircle2 size={14} color={COLORS.accent} style={{marginTop: 2, flexShrink: 0}} />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: COLORS.surfaceInset,
              border: `1px solid ${COLORS.border}`,
              fontSize: 11,
              color: COLORS.textFaint,
              fontFamily: FONT.mono,
              textAlign: 'center',
            }}
          >
            下载 · 调参 · 额外参数 · 加载切换
          </div>
        </div>

        {/* Column 2: 启动 · 停止 · 转发 */}
        <div
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.borderStrong}`,
            borderRadius: RADIUS.card,
            padding: '22px 20px',
            boxShadow: LW.shadow,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            opacity: col2Enter,
            transform: `translateY(${(1 - col2Enter) * 24}px) scale(${0.96 + 0.04 * col2Enter})`,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <Chip icon={Terminal}>启动 · 停止 · 转发</Chip>
            <span style={{fontSize: 11, color: COLORS.textMuted}}>本机其他引擎</span>
          </div>

          <div>
            <div style={{fontSize: 17, fontWeight: 700, color: COLORS.text}}>
              本机的其他引擎
            </div>
            <div style={{fontSize: 12, color: COLORS.textMuted, marginTop: 3}}>
              Strata · Ollama 等
            </div>
          </div>

          <div style={{display: 'flex', flexDirection: 'column', gap: 9, flex: 1}}>
            {[
              '启动命令拉起（提供 AI 提示词辅助）',
              '一键启动 · 启动中检测模型就绪',
              '一键关闭（仅限本次由工具启动的进程）',
              '独占本机：自动卸载本地模型避让显存',
            ].map((item, idx) => (
              <div key={idx} style={{display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: COLORS.text, lineHeight: 1.4}}>
                <CheckCircle2 size={14} color={COLORS.ok} style={{marginTop: 2, flexShrink: 0}} />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: COLORS.surfaceInset,
              border: `1px solid ${COLORS.border}`,
              fontSize: 11,
              color: COLORS.textFaint,
              fontFamily: FONT.mono,
              textAlign: 'center',
            }}
          >
            启动 · 停止 · 转发
          </div>
        </div>

        {/* Column 3: 仅转发 */}
        <div
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.card,
            padding: '22px 20px',
            boxShadow: LW.shadow,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            opacity: col3Enter,
            transform: `translateY(${(1 - col3Enter) * 24}px) scale(${0.96 + 0.04 * col3Enter})`,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <Chip icon={Globe2}>仅转发</Chip>
            <span style={{fontSize: 11, color: COLORS.textMuted}}>外部与云端 API</span>
          </div>

          <div>
            <div style={{fontSize: 17, fontWeight: 700, color: COLORS.text}}>
              其他机器服务与云端
            </div>
            <div style={{fontSize: 12, color: COLORS.textMuted, marginTop: 3}}>
              NInfer · vLLM · 外部 API
            </div>
          </div>

          <div style={{display: 'flex', flexDirection: 'column', gap: 9, flex: 1}}>
            {[
              '局域网或远程机器 API 接入',
              '统一前缀路由（前缀-模型id）',
              '请求透明预处理（图片自动压缩）',
              '共享公网隧道鉴权与无对话请求记录',
            ].map((item, idx) => (
              <div key={idx} style={{display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: COLORS.text, lineHeight: 1.4}}>
                <CheckCircle2 size={14} color={COLORS.textMuted} style={{marginTop: 2, flexShrink: 0}} />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: COLORS.surfaceInset,
              border: `1px solid ${COLORS.border}`,
              fontSize: 11,
              color: COLORS.textFaint,
              fontFamily: FONT.mono,
              textAlign: 'center',
            }}
          >
            仅转发 · 客户端配置零改动
          </div>
        </div>
      </div>
    </div>
  );
};
