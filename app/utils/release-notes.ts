// Release notes are Markdown written by the maintainer, shown as plain text blocks (never as
// HTML): headings, list items and paragraphs; inline markers are dropped.
export interface NotesBlock { kind: 'heading' | 'item' | 'text', text: string }

const inline = (s: string) => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|`)/g, '')
  .trim()

export function notesBlocks(md: string): NotesBlock[] {
  const out: NotesBlock[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'text', text: inline(para.join(' ')) })
    para = []
  }
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) flush()
    else if (h) { flush(); out.push({ kind: 'heading', text: inline(h[1]!) }) }
    else if (li) { flush(); out.push({ kind: 'item', text: inline(li[1]!) }) }
    else para.push(line)
  }
  flush()
  return out.filter(b => b.text)
}
