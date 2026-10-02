import { expect, test } from 'bun:test'
import { notesBlocks } from '../../app/utils/release-notes'

test('release notes become plain heading / item / text blocks, never markup', () => {
  const md = '## 新增\n\n- **应用内更新**：检查、下载、校验\n* 设置里查看 `版本号`\n\n说明第一行\n第二行\n\n---\n<!-- hidden -->\n1. [发布页](https://example.com) <b>x</b>'
  expect(notesBlocks(md)).toEqual([
    { kind: 'heading', text: '新增' },
    { kind: 'item', text: '应用内更新：检查、下载、校验' },
    { kind: 'item', text: '设置里查看 版本号' },
    { kind: 'text', text: '说明第一行 第二行' },
    { kind: 'item', text: '发布页 <b>x</b>' },
  ])
  expect(notesBlocks('')).toEqual([])
})
