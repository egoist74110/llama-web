import React from 'react';
import {Lock, Pencil, Play, PlugZap, Plus, Square, Trash2, LoaderCircle} from 'lucide-react';
import {COLORS, FONT} from '../theme';
import {AppCard, Btn, Chip, PageHeader, Seg, StatusPill, Switch} from '../ui/lw';

// Replica of app/pages/connections.vue, Upstream card list, and ExclusiveNotice.vue.
// Native app coordinates: 1440 x 810.
// Pure component: every visual state comes from props.

export const CONNECTIONS_LAYOUT = {
  addServiceBtn: {x: 1334, y: 52},
  exclusiveNotice: {x: 838, y: 116},
  strataCard: {x: 838, y: 260, w: 1116, h: 360},
  strataStartBtn: {x: 1336, y: 254},
  strataCancelBtn: {x: 1336, y: 254},
  strataStopBtn: {x: 1336, y: 254},
  strataLocalSwitch: {x: 1360, y: 396},
  strataExclusiveSwitch: {x: 1360, y: 446},
  strataTestBtn: {x: 1198, y: 535},
  strataEditBtn: {x: 1278, y: 535},
  ninferCard: {x: 838, y: 630, w: 1116, h: 260},
  ninferLocalSwitch: {x: 1360, y: 794},
  ninferTestBtn: {x: 1334, y: 883},
} as const;

export type UpstreamStatus = 'offline' | 'starting' | 'online';

export type ConnectionsPageProps = {
  // Strata card props
  strataState?: UpstreamStatus;
  waitedSeconds?: number;
  strataExclusive?: boolean;
  strataLocal?: boolean;
  strataModels?: readonly string[];
  showStrataModels?: boolean;
  exclusiveNotice?: boolean;
  exclusiveHolder?: string;

  // NInfer card props
  ninferOnline?: boolean;
  ninferModels?: readonly string[];

  // Button pressed feedback (0..1)
  addServicePressed?: number;
  strataStartPressed?: number;
  strataCancelPressed?: number;
  strataStopPressed?: number;
  strataExclusivePressed?: number;
  strataTestPressed?: number;
  strataEditPressed?: number;
  ninferTestPressed?: number;
};

export const ConnectionsPage: React.FC<ConnectionsPageProps> = ({
  strataState = 'offline',
  waitedSeconds = 1,
  strataExclusive = true,
  strataLocal = true,
  strataModels = ['Strata-qwen3-32b'],
  showStrataModels = false,
  exclusiveNotice = false,
  exclusiveHolder = 'Strata',
  ninferOnline = true,
  ninferModels = ['NInfer-qwen3-32b'],
  addServicePressed = 0,
  strataStartPressed = 0,
  strataCancelPressed = 0,
  strataStopPressed = 0,
  strataTestPressed = 0,
  strataEditPressed = 0,
  ninferTestPressed = 0,
}) => {
  const isStrataUp = strataState === 'online';
  const isStrataStarting = strataState === 'starting';
  const displayStrataModels = showStrataModels || isStrataUp;

  return (
    <div style={{width: 1116, display: 'flex', flexDirection: 'column', gap: 18}}>
      {/* Page Header */}
      <PageHeader
        title="接入"
        subtitle="把别人的 OpenAI 兼容服务接进来。客户端仍然只连 llama-web，同样享受图片压缩、公网鉴权和请求记录。"
        actions={
          <Btn
            icon={Plus}
            label="添加外部服务"
            size="md"
            pressed={addServicePressed}
          />
        }
      />

      {/* Exclusive notice banner (decision 56 ⑨) */}
      {exclusiveNotice ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '12px 18px',
            borderRadius: 14,
            background: COLORS.surface,
            border: `1px solid ${COLORS.warn}`,
            boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          }}
        >
          <Lock size={16} color={COLORS.warn} style={{marginTop: 2, flexShrink: 0}} />
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>
              外部服务「{exclusiveHolder}」正在独占本机
            </div>
            <div style={{fontSize: 12, color: COLORS.textMuted, marginTop: 2, lineHeight: 1.4}}>
              本地模型已经卸载，在它停止运行前不能启动本地模型。要同时用本地模型，需要关掉它的「独占本机」开关。
            </div>
          </div>
        </div>
      ) : null}

      {/* Card 1: Strata */}
      <AppCard
        title="Strata"
        hint="http://127.0.0.1:8080/v1"
        actions={
          isStrataUp ? (
            <StatusPill kind="ready" label="在线" />
          ) : isStrataStarting ? (
            <StatusPill kind="loading" label="启动中" />
          ) : (
            <StatusPill kind="failed" label="连不上" />
          )
        }
      >
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          {/* Info meta row */}
          <div style={{display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, fontSize: 12, color: COLORS.textMuted}}>
            <span style={{fontFamily: FONT.mono}}>
              {displayStrataModels ? `${strataModels.length} 个模型` : '0 个模型'}
            </span>
            <span>{isStrataUp ? '最近检测 3 秒前' : '还没有检测过'}</span>
            {displayStrataModels ? <span>上次测试连接 18:30:00</span> : null}
          </div>

          {/* Launch panel (下沉底色) */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderRadius: 10,
              background: COLORS.surfaceInset,
              padding: '12px 14px',
              border: `1px solid ${COLORS.border}`,
            }}
          >
            {isStrataStarting ? (
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8}}>
                <span style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: COLORS.text}}>
                  <LoaderCircle size={16} color={COLORS.warn} style={{animation: 'spin 1s linear infinite', flexShrink: 0}} />
                  正在启动，等它列出模型… 已等 {waitedSeconds} 秒
                </span>
                <Btn
                  variant="outline"
                  label="取消"
                  size="sm"
                  pressed={strataCancelPressed}
                />
              </div>
            ) : isStrataUp ? (
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8}}>
                <span style={{fontSize: 12, color: COLORS.textMuted}}>
                  服务由这里启动，正在运行。
                </span>
                <Btn
                  variant="outline"
                  icon={Square}
                  label="关闭"
                  size="sm"
                  pressed={strataStopPressed}
                />
              </div>
            ) : (
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8}}>
                <span style={{fontSize: 12, color: COLORS.textMuted}}>
                  点「启动」会运行你在「编辑」里保存的命令，然后一直检查，等它列出模型就算启动成功。
                </span>
                <Btn
                  variant="primary"
                  icon={Play}
                  label="启动"
                  size="sm"
                  pressed={strataStartPressed}
                />
              </div>
            )}
          </div>

          {/* Client prefix note */}
          <div style={{fontSize: 13, color: COLORS.textMuted}}>
            客户端用「Strata-模型id」调用，名称就是模型名的前缀。{' '}
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
              例如 Strata-qwen3-32b
            </span>
          </div>

          {/* Models chip list */}
          {displayStrataModels && strataModels.length > 0 ? (
            <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
              {strataModels.map((m) => (
                <Chip key={m} mono>
                  {m}
                </Chip>
              ))}
            </div>
          ) : null}

          {/* Divider & Settings */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 12, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14}}>
            {/* 本机运行 */}
            <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12}}>
              <div style={{minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>在本机运行</div>
                <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2}}>
                  这个服务跑在这台电脑上，会和本地模型抢显存和内存。
                </div>
              </div>
              <Switch on={strataLocal} />
            </div>

            {/* 独占本机 (only when local) */}
            {strataLocal ? (
              <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12}}>
                <div style={{minWidth: 0}}>
                  <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>独占本机</div>
                  <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2}}>
                    它运行时，llama-web 会卸载自己的本地模型，也不允许同时再加载本地模型，两边不会一起占着机器。
                  </div>
                  {isStrataUp && strataExclusive ? (
                    <div style={{fontSize: 12, color: COLORS.warn, marginTop: 4}}>
                      正在独占本机：本地模型已卸载，不能启动。
                    </div>
                  ) : null}
                </div>
                <Switch on={strataExclusive} />
              </div>
            ) : null}

            {/* 图片压缩 */}
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
              <div style={{minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>图片压缩</div>
                <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2}}>
                  「沿用全局」按设置页的图片压缩开关；开 / 关只对这个服务生效。
                </div>
              </div>
              <Seg options={['沿用全局', '开', '关']} active={0} height={26} />
            </div>

            {/* API key & actions */}
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
                <span style={{fontWeight: 500, color: COLORS.text}}>API key</span>
                <span style={{fontSize: 12, color: COLORS.ok}}>已保存</span>
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                <Btn
                  variant="outline"
                  icon={PlugZap}
                  label="测试连接"
                  size="sm"
                  pressed={strataTestPressed}
                />
                <Btn
                  variant="outline"
                  icon={Pencil}
                  label="编辑"
                  size="sm"
                  pressed={strataEditPressed}
                />
                <Btn variant="danger" icon={Trash2} label="删除" size="sm" />
              </div>
            </div>
          </div>
        </div>
      </AppCard>

      {/* Card 2: NInfer */}
      <AppCard
        title="NInfer"
        hint="http://192.168.1.50:8000/v1"
        actions={<StatusPill kind={ninferOnline ? 'ready' : 'failed'} label={ninferOnline ? '在线' : '连不上'} />}
      >
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          {/* Info meta row */}
          <div style={{display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, fontSize: 12, color: COLORS.textMuted}}>
            <span style={{fontFamily: FONT.mono}}>
              {ninferModels.length} 个模型
            </span>
            <span>最近检测 10 秒前</span>
          </div>

          {/* Client prefix note */}
          <div style={{fontSize: 13, color: COLORS.textMuted}}>
            客户端用「NInfer-模型id」调用，名称就是模型名的前缀。{' '}
            <span style={{fontFamily: FONT.mono, fontSize: 12, color: COLORS.textFaint}}>
              例如 NInfer-qwen3-32b
            </span>
          </div>

          {/* Models chip list */}
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
            {ninferModels.map((m) => (
              <Chip key={m} mono>
                {m}
              </Chip>
            ))}
          </div>

          {/* Divider & Settings */}
          <div style={{display: 'flex', flexDirection: 'column', gap: 12, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14}}>
            {/* 本机运行: 关 */}
            <div style={{display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12}}>
              <div style={{minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>在本机运行</div>
                <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2}}>
                  这个服务跑在这台电脑上，会和本地模型抢显存和内存。
                </div>
              </div>
              <Switch on={false} />
            </div>

            {/* 图片压缩 */}
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
              <div style={{minWidth: 0}}>
                <div style={{fontSize: 13, fontWeight: 500, color: COLORS.text}}>图片压缩</div>
                <div style={{fontSize: 12, color: COLORS.textFaint, marginTop: 2}}>
                  「沿用全局」按设置页的图片压缩开关；开 / 关只对这个服务生效。
                </div>
              </div>
              <Seg options={['沿用全局', '开', '关']} active={0} height={26} />
            </div>

            {/* API key & actions (只有测试连接) */}
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}>
                <span style={{fontWeight: 500, color: COLORS.text}}>API key</span>
                <span style={{fontSize: 12, color: COLORS.ok}}>已保存</span>
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                <Btn
                  variant="outline"
                  icon={PlugZap}
                  label="测试连接"
                  size="sm"
                  pressed={ninferTestPressed}
                />
              </div>
            </div>
          </div>
        </div>
      </AppCard>
    </div>
  );
};
