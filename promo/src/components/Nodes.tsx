import React from 'react';
import {AppIcon} from './AppIcon';
import {Card, Line} from './Card';
import {Pill} from './Controls';
import {Glyph, GlyphName, GlyphTile} from './Glyph';
import {ClientKind, PRODUCT, ServiceKind} from '../copy';
import {COLORS, FONT, TYPE} from '../theme';

// Diagram nodes reused across scenes: clients on the left, llama-web hub, services on the right.

const CLIENT_GLYPH: Record<ClientKind, GlyphName> = {chat: 'chat', agent: 'agent', ide: 'code'};
const SERVICE_GLYPH: Record<ServiceKind, GlyphName> = {local: 'chip', cloud: 'cloud', server: 'server'};

export const CLIENT_SIZE = {w: 300, h: 100} as const;
export const SERVICE_SIZE = {w: 360, h: 118} as const;
export const HUB_SIZE = {w: 500, h: 200} as const;

type Placement = {
  cx: number;
  cy: number;
  scale?: number;
  rotate?: number;
  opacity?: number;
};

export const ClientCard: React.FC<Placement & {zh: string; en: string; kind: ClientKind; highlight?: boolean}> = ({
  zh,
  en,
  kind,
  highlight,
  ...place
}) => (
  <Card {...place} w={CLIENT_SIZE.w} h={CLIENT_SIZE.h} highlight={highlight} padding="0 22px">
    <div style={{display: 'flex', alignItems: 'center', gap: 16, height: '100%'}}>
      <GlyphTile name={CLIENT_GLYPH[kind]} />
      <div style={{minWidth: 0}}>
        <Line style={{fontSize: TYPE.body, fontWeight: 600, color: COLORS.text}}>{zh}</Line>
        <Line style={{fontSize: TYPE.tiny, color: COLORS.textFaint, marginTop: 2}}>{en}</Line>
      </div>
    </div>
  </Card>
);

// Masked API key: dots + a fake 4-char tail. `keyTail === null` renders "无需 key".
const MaskedKey: React.FC<{tail: string | null}> = ({tail}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
    <Glyph name="key" size={16} color={COLORS.textFaint} />
    <Line style={{fontFamily: FONT.mono, fontSize: TYPE.tiny, color: COLORS.textFaint, letterSpacing: 1}}>
      {tail === null ? 'no key' : `sk-••••••••${tail}`}
    </Line>
  </div>
);

export const ServiceCard: React.FC<
  Placement & {
    name: string;
    url: string;
    keyTail: string | null;
    kind: ServiceKind;
    // Optional status badge in the top-right corner (e.g. a flashing "401").
    badge?: {text: string; tone: 'danger' | 'ok' | 'neutral' | 'accent'; opacity: number} | null;
    // 0..1: fades the key row out (once llama-web holds the keys).
    keyOpacity?: number;
  }
> = ({name, url, keyTail, kind, badge, keyOpacity = 1, ...place}) => (
  <Card {...place} w={SERVICE_SIZE.w} h={SERVICE_SIZE.h} padding="14px 20px">
    <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
      <Glyph name={SERVICE_GLYPH[kind]} size={22} color={COLORS.textMuted} />
      <Line style={{fontSize: TYPE.body, fontWeight: 600, color: COLORS.text, flex: 1}}>{name}</Line>
      {badge ? (
        <Pill tone={badge.tone} style={{opacity: badge.opacity, fontSize: 16, padding: '3px 10px'}}>
          {badge.text}
        </Pill>
      ) : null}
    </div>
    <Line style={{fontFamily: FONT.mono, fontSize: TYPE.mono, color: COLORS.textMuted, marginTop: 10}}>{url}</Line>
    <div style={{marginTop: 8, opacity: keyOpacity}}>
      <MaskedKey tail={keyTail} />
    </div>
  </Card>
);

// llama-web itself. Always highlighted with the accent.
export const HubCard: React.FC<Placement & {glow?: number}> = ({glow = 1, ...place}) => (
  <Card {...place} w={HUB_SIZE.w} h={HUB_SIZE.h} highlight raised padding="0 32px">
    <div style={{display: 'flex', alignItems: 'center', gap: 26, height: '100%'}}>
      <AppIcon size={104} glow={glow} />
      <div style={{minWidth: 0}}>
        <Line style={{fontSize: 46, fontWeight: 700, color: COLORS.text, letterSpacing: -0.5}}>{PRODUCT.name}</Line>
        <Line style={{fontSize: TYPE.small, color: COLORS.textMuted, marginTop: 6, lineHeight: 1.3}}>
          {PRODUCT.taglineLine1}
        </Line>
        <Line style={{fontSize: TYPE.small, color: COLORS.textMuted, lineHeight: 1.3}}>{PRODUCT.taglineLine2}</Line>
      </div>
    </div>
  </Card>
);
