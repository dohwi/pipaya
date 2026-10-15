import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import MarkdownIt from 'markdown-it'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages')
const PORT = Number(process.env.PORT || 8800)
const md = new MarkdownIt({ linkify: true }) // html 비허용(기본)
const app = new Hono()

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const validName = (n) => /^[^/\\.\0][^/\\\0]{0,99}$/.test(n)
const file = (n) => path.join(PAGES, n + '.md')

async function list() {
  return (await fs.readdir(PAGES)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
}

async function layout(title, body, q = '') {
  const names = await list()
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{margin:0;font:16px/1.6 system-ui,sans-serif;display:flex;min-height:100vh;color:#222}
nav{width:220px;padding:1rem;background:#f4f4f6;box-sizing:border-box}
nav a{display:block;padding:2px 0;color:#345;text-decoration:none}
main{flex:1;max-width:800px;padding:1rem 2rem}
a.new{color:#c33}textarea{width:100%;height:60vh;font:14px monospace}
pre{background:#f4f4f6;padding:.8rem;overflow:auto}code{background:#f4f4f6}
.bar{display:flex;gap:1rem;align-items:baseline}
@media(max-width:700px){body{flex-direction:column}nav{width:auto}}
</style>
<nav><b><a href="/">📚 Wiki</a></b>
<form action="/search"><input name="q" value="${esc(q)}" placeholder="검색" style="width:100%;box-sizing:border-box"></form>
<form action="/new" style="margin:.5rem 0"><input name="name" placeholder="새 페이지 이름" style="width:100%;box-sizing:border-box"></form>
${names.map((n) => `<a href="/w/${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}</nav>
<main>${body}</main></html>`
}

async function render(text) {
  const names = new Set(await list())
  const withLinks = text.replace(/\[\[([^\]\n]+)\]\]/g, (_, n) => {
    const name = n.trim()
    return `[${name}${names.has(name) ? '' : ' (없음)'}](/w/${encodeURIComponent(name)})`
  })
  return md.render(withLinks)
}

app.get('/', (c) => c.redirect('/w/Home'))

app.get('/new', (c) => {
  const n = (c.req.query('name') || '').trim()
  return validName(n) ? c.redirect(`/w/${encodeURIComponent(n)}/edit`) : c.redirect('/')
})

app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase()
  const hits = []
  if (q) for (const n of await list()) {
    const t = await fs.readFile(file(n), 'utf8')
    if (n.toLowerCase().includes(q) || t.toLowerCase().includes(q)) hits.push(n)
  }
  return c.html(await layout('검색', `<h1>검색: ${esc(q)}</h1><ul>${hits.map((n) => `<li><a href="/w/${encodeURIComponent(n)}">${esc(n)}</a></li>`).join('') || '<li>결과 없음</li>'}</ul>`, q))
})

app.get('/w/:name', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  let text
  try { text = await fs.readFile(file(name), 'utf8') } catch { return c.redirect(`/w/${encodeURIComponent(name)}/edit`) }
  const bar = `<div class="bar"><a href="/w/${encodeURIComponent(name)}/edit">✏️ 편집</a></div>`
  return c.html(await layout(name, bar + (await render(text))))
})

app.get('/w/:name/edit', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  const text = await fs.readFile(file(name), 'utf8').catch(() => `# ${name}\n\n`)
  return c.html(await layout(`편집: ${name}`, `<h1>편집: ${esc(name)}</h1>
<form method="post"><textarea name="text">${esc(text)}</textarea><p><button>저장</button> <a href="/w/${encodeURIComponent(name)}">취소</a></p></form>`))
})

app.post('/w/:name/edit', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  const { text } = await c.req.parseBody()
  await fs.writeFile(file(name), String(text ?? '').replace(/\r\n/g, '\n'))
  return c.redirect(`/w/${encodeURIComponent(name)}`, 303)
})

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (i) => console.log(`wiki on :${i.port}`))
