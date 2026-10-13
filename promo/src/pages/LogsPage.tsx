import React from 'react';
import {Pause, RefreshCw, Search} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {Btn, Chip, Input, LwCard, PageHeader, Seg} from '../ui/lw';

// Replica of app/pages/logs.vue (Requests tab).
// Native app coordinates (1440 x 810).
// Pure component: every visual state comes from props.

export const LOGS_LAYOUT = {
  pageHeader: {x: 320, y: 80},
  requestsTab: {x: 430, y: 175},
  modelSelect: {x: 620, y: 175},
  rangeSelect: {x: 770, y: 175},
  searchInput: {x: 950, y: 175},
  pauseBtn: {x: 1120, y: 175},
  noContentNote: {x: 400, y: 236},
  tableCard: {x: 820, y: 480},
  imageEditRow: {x: 420, y: 275},
  imageRow: {x: 420, y: 305},
  mossRow: {x: 420, y: 345},
  ttsRow: {x: 420, y: 388},
  strataRow: {x: 420, y: 430},
  row3: {x: 420, y: 472},
} as const;

export type RequestRowItem = {
  id: string;
  time: string;
  source: 'local' | 'lan' | 'public';
  model: string;
  profile?: string;
  stream?: boolean;
  status: string; // e.g. "200 成功"
  outcome?: 'ok' | 'error' | 'aborted';
  duration: string;
  tokens?: string; // e.g. "1234 → 567" or "—"
  images?: string; // e.g. "1 张，3.1 MB → 186 KB" or "—"
  params?: string;
  enter?: number; // 0..1 for animated entrance
  highlight?: number; // 0..1 for glow highlight
};

export const DEFAULT_REQUEST_ROWS: readonly RequestRowItem[] = [
  {
    id: 'imageEdit',
    time: '18:06:06',
    source: 'lan',
    model: 'QwenImage-qwen-edit-2511',
    status: '200 成功',
    duration: '25.97 s',
    tokens: '—',
    images: '—',
    params: 'path=/v1/images/edits',
  },
  {
    id: 'image',
    time: '18:05:40',
    source: 'lan',
    model: 'QwenImage-qwen-image-2.1',
    status: '200 成功',
    duration: '4.82 s',
    tokens: '—',
    images: '—',
    params: 'path=/v1/images/generations size=1024x1024',
  },
  {
    id: 'moss',
    time: '18:05:22',
    source: 'lan',
    model: 'MOSS-OpenMOSS-Team/MOSS-Transcribe-Diarize',
    status: '200 成功',
    duration: '1.24 s',
    tokens: '—',
    images: '—',
    params: 'path=/v1/audio/transcriptions',
  },
  {
    id: 'tts',
    time: '18:05:02',
    source: 'lan',
    model: 'TTS-诗歌剧_ZH',
    status: '200 成功',
    duration: '820 ms',
    tokens: '—',
    images: '—',
    params: 'path=/v1/audio/speech voice=诗歌剧_ZH',
  },
  {
    id: 'strata',
    time: '18:04:38',
    source: 'lan',
    model: 'Strata-qwen3-32b',
    stream: true,
    status: '200 成功',
    duration: '2.31 s',
    tokens: '1234 → 567',
    images: '1 张，3.1 MB → 186 KB',
    params: 'temperature=0.7 stream=true',
  },
  {
    id: 'r3',
    time: '18:03:10',
    source: 'local',
    model: 'Qwen3-8B',
    profile: '默认',
    status: '200 成功',
    duration: '1.45 s',
    tokens: '420 → 188',
    images: '—',
    params: 'temperature=0.7',
  },
  {
    id: 'r4',
    time: '18:00:22',
    source: 'lan',
    model: 'Qwen3-8B',
    profile: '长上下文',
    status: '200 成功',
    duration: '3.10 s',
    tokens: '2840 → 412',
    images: '—',
    params: 'temperature=0.7 max_tokens=2048',
  },
  {
    id: 'r5',
    time: '17:58:05',
    source: 'public',
    model: 'Qwen3-8B',
    profile: '默认',
    status: '200 成功',
    duration: '1.82 s',
    tokens: '890 → 215',
    images: '—',
    params: 'temperature=0.8',
  },
];

export type LogsPageProps = {
  rows?: readonly RequestRowItem[];
  activeTab?: number; // 0: 模型输出, 1: 事件, 2: 请求, 3: 用量
  modelFilter?: string;
  rangeFilter?: string;
  paused?: boolean;
  style?: React.CSSProperties;
};

export const LogsPage: React.FC<LogsPageProps> = ({
  rows = DEFAULT_REQUEST_ROWS,
  activeTab = 2,
  modelFilter = '全部模型',
  rangeFilter = '实时（最近内容）',
  paused = false,
  style,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: 1120,
        margin: '0 auto',
        padding: '24px 0 32px',
        fontFamily: FONT.sans,
        ...style,
      }}
    >
      {/* Page Header */}
      <PageHeader
        title="日志"
        subtitle="模型输出、事件和请求。页面里只保留最近的内容，完整记录保存在 data/logs，重启后仍可查看。"
      />

      {/* Filter Toolbar */}
      <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
        <Seg
          options={['模型输出', '事件', '请求', '用量']}
          active={activeTab}
        />

        <Input select width={170}>
          {modelFilter}
        </Input>

        <Input select width={200}>
          {rangeFilter}
        </Input>

        <div style={{flex: 1, minWidth: 180}}>
          <Input placeholder="在当前内容里搜索">
            <div style={{display: 'flex', alignItems: 'center', gap: 6, color: COLORS.textFaint}}>
              <Search size={14} />
              <span>在当前内容里搜索</span>
            </div>
          </Input>
        </div>

        <Btn
          variant="outline"
          icon={Pause}
          label={paused ? '继续' : '暂停'}
        />

        <Btn
          variant="outline"
          icon={RefreshCw}
        />
      </div>

      {/* Notice line above table (from i18n: t.logs.requests.noContentNote) */}
      <div
        style={{
          fontSize: 12,
          color: COLORS.textFaint,
          paddingLeft: 2,
          letterSpacing: '0.01em',
        }}
      >
        请求记录不包含对话内容，也不包含 Authorization。
      </div>

      {/* Table Card */}
      <LwCard style={{overflow: 'hidden'}}>
        {/* Card subheader */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: `1px solid ${COLORS.border}`,
            fontSize: 12,
            color: COLORS.textFaint,
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: COLORS.ok,
                boxShadow: `0 0 8px ${COLORS.ok}`,
              }}
            />
            <span>实时</span>
          </div>
          <span style={{fontFamily: FONT.mono}}>{rows.length} 行</span>
        </div>

        {/* Requests Table */}
        <div style={{overflowX: 'auto', width: '100%'}}>
          <table
            style={{
              width: '100%',
              minWidth: 896,
              borderCollapse: 'collapse',
              textAlign: 'left',
              fontSize: 13,
            }}
          >
            <thead>
              <tr
                style={{
                  background: COLORS.surfaceRaised,
                  borderBottom: `1px solid ${COLORS.border}`,
                  color: COLORS.textMuted,
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                <th style={{padding: '10px 14px', width: 78, whiteSpace: 'nowrap'}}>时间</th>
                <th style={{padding: '10px 12px', width: 74, whiteSpace: 'nowrap'}}>来源</th>
                <th style={{padding: '10px 14px', width: 170, whiteSpace: 'nowrap'}}>模型</th>
                <th style={{padding: '10px 12px', width: 86, whiteSpace: 'nowrap'}}>结果</th>
                <th style={{padding: '10px 12px', width: 76, whiteSpace: 'nowrap'}}>耗时</th>
                <th style={{padding: '10px 14px', minWidth: 160, whiteSpace: 'nowrap'}}>token（输入 → 输出）</th>
                <th style={{padding: '10px 14px', width: 140, whiteSpace: 'nowrap'}}>图片</th>
                <th style={{padding: '10px 14px', whiteSpace: 'nowrap'}}>参数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const enter = r.enter ?? 1;
                const hi = r.highlight ?? 0;
                const sourceLabel =
                  r.source === 'local' ? '本机' : r.source === 'lan' ? '局域网' : '公网';

                return (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom: `1px solid rgba(255, 255, 255, 0.04)`,
                      opacity: enter,
                      transform: `translateY(${(1 - enter) * -8}px)`,
                      background:
                        hi > 0
                          ? `rgba(79, 91, 213, ${0.14 * hi})`
                          : 'transparent',
                    }}
                  >
                    {/* 时间 */}
                    <td
                      style={{
                        padding: '10px 14px',
                        fontFamily: FONT.mono,
                        fontSize: 12,
                        color: COLORS.textFaint,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.time}
                    </td>

                    {/* 来源 */}
                    <td style={{padding: '10px 12px', whiteSpace: 'nowrap'}}>
                      <Chip
                        accent={r.source === 'public'}
                        style={{height: 20, fontSize: 11, padding: '0 6px'}}
                      >
                        {sourceLabel}
                      </Chip>
                    </td>

                    {/* 模型 */}
                    <td style={{padding: '10px 14px', whiteSpace: 'nowrap'}}>
                      <span style={{fontWeight: 600, color: COLORS.text}}>{r.model}</span>
                      {r.profile ? (
                        <span style={{color: COLORS.textMuted, fontSize: 12}}> · {r.profile}</span>
                      ) : null}
                      {r.stream ? (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 11,
                            color: COLORS.accentText,
                            background: COLORS.accentSoft,
                            padding: '1px 5px',
                            borderRadius: 4,
                          }}
                        >
                          流式
                        </span>
                      ) : null}
                    </td>

                    {/* 结果 */}
                    <td style={{padding: '10px 12px', whiteSpace: 'nowrap'}}>
                      <span
                        style={{
                          color:
                            r.outcome === 'error'
                              ? COLORS.danger
                              : r.outcome === 'aborted'
                                ? COLORS.warn
                                : COLORS.ok,
                          fontWeight: 500,
                        }}
                      >
                        {r.status}
                      </span>
                    </td>

                    {/* 耗时 */}
                    <td
                      style={{
                        padding: '10px 12px',
                        fontFamily: FONT.mono,
                        fontSize: 12,
                        color: COLORS.text,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.duration}
                    </td>

                    {/* token (输入 → 输出) */}
                    <td
                      style={{
                        padding: '10px 14px',
                        fontFamily: FONT.mono,
                        fontSize: 12,
                        color: r.tokens === '—' ? COLORS.textFaint : COLORS.text,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.tokens ?? '—'}
                    </td>

                    {/* 图片 */}
                    <td
                      style={{
                        padding: '10px 14px',
                        fontSize: 12,
                        color: r.images === '—' ? COLORS.textFaint : COLORS.text,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.images ?? '—'}
                    </td>

                    {/* 参数 */}
                    <td
                      style={{
                        padding: '10px 14px',
                        fontFamily: FONT.mono,
                        fontSize: 11.5,
                        color: COLORS.textFaint,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 240,
                      }}
                    >
                      {r.params ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </LwCard>
    </div>
  );
};
