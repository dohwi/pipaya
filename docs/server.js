import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import MarkdownIt from 'markdown-it'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages')
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8800)
const md = new MarkdownIt({ linkify: true }) // html 비허용(기본)
const app = new Hono()

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const validName = (n) => /^[^/\\.\0][^/\\\0]{0,99}$/.test(n)
const file = (n) => path.join(PAGES, n + '.md')

async function list() {
  return (await fs.readdir(PAGES)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
}

async function layout(title, body, q = '', active = '', toc = '') {
  const names = await list()
  return `<!doctype html><html lang="ko" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/img/favicon.svg"><link rel="stylesheet" href="/style.css">
<script>document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')</script>
<aside class="side">
<div class="brand"><a href="/"><img class="dark" src="/assets/img/pipaya-dark.svg" alt=""><img class="light" src="/assets/img/pipaya-light.svg" alt="">pipaya<small>docs</small></a><button id="theme" title="테마 전환" onclick="var t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=localStorage.theme=t">◐</button></div>
<form action="/search"><input name="q" value="${esc(q)}" placeholder="검색…" autocomplete="off"></form>
<form action="/new"><input name="name" placeholder="+ 새 페이지" autocomplete="off"></form>
<div class="label">페이지</div>
<nav class="pages">${names.map((n) => `<a href="/w/${encodeURIComponent(n)}"${n === active ? ' class="active"' : ''}>${esc(n)}</a>`).join('')}</nav>
</aside>
<main><div class="wrap">${body}</div>${toc}</main></html>`
}

const slug = (t) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'

async function render(text) {
  const names = new Set(await list())
  const withLinks = text.replace(/\[\[([^\]\n]+)\]\]/g, (_, n) => {
    const name = n.trim()
    return `[${name}${names.has(name) ? '' : ' (없음)'}](/w/${encodeURIComponent(name)})`
  })
  const tokens = md.parse(withLinks, {})
  const toc = []
  const seen = new Map()
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open' || !['h2', 'h3'].includes(t.tag)) return
    const title = tokens[i + 1].content
    let id = slug(title)
    const k = seen.get(id) || 0
    seen.set(id, k + 1)
    if (k) id += '-' + k
    t.attrSet('id', id)
    toc.push({ id, title, level: t.tag })
  })
  const html = md.renderer.render(tokens, md.options, {})
    .replace(/<a href="(\/w\/[^"]+)">([^<]* \(없음\))<\/a>/g, '<a class="missing" href="$1">$2</a>')
    .replace(/<(h[23]) id="([^"]+)">/g, '<$1 id="$2"><a href="#$2">').replace(/<\/(h[23])>/g, '</a></$1>')
  const tocHtml = toc.length > 1 ? `<aside class="toc"><div class="label">목차</div>${toc.map((x) => `<a class="${x.level === 'h3' ? 'l3' : ''}" href="#${x.id}">${esc(x.title)}</a>`).join('')}</aside>` : ''
  return { html, tocHtml }
}

app.get('/style.css', async (c) => c.body(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'style.css')), 200, { 'Content-Type': 'text/css; charset=utf-8' }))

app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, 'public')) || '.', rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }))

async function landing() {
  const names = await list()
  const cards = []
  for (const n of names) {
    const t = await fs.readFile(file(n), 'utf8')
    const desc = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join(' ').replace(/[`*_>\[\]]/g, '').slice(0, 120)
    cards.push(`<a class="card rise" href="/w/${encodeURIComponent(n)}"><b>${esc(n)} <span>→</span></b><p>${esc(desc) || '&nbsp;'}</p><code>${n}.md</code></a>`)
  }
  return `<!doctype html><html lang="ko" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pipaya docs</title><meta name="description" content="pipaya 위키">
<link rel="icon" href="/assets/img/favicon.svg"><link rel="stylesheet" href="/assets/landing.css">
<script>document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')</script>
<header><a class="logo" href="/"><img src="/assets/img/pipaya-dark.svg" class="mascot-sm dark" alt=""><img src="/assets/img/pipaya-light.svg" class="mascot-sm light" alt="">pipaya<span style="color:var(--text-faint);font-weight:500"> docs</span></a>
<nav><a class="pill" href="/w/Home">문서</a><button class="pill icon" title="테마 전환" aria-label="테마 전환" onclick="var t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=localStorage.theme=t">◐</button></nav></header>
<section class="hero">
<img class="mascot dark" src="/assets/img/pipaya-dark.svg" alt="pipaya"><img class="mascot light" src="/assets/img/pipaya-light.svg" alt="pipaya">
<div class="tag rise"><i></i>${names.length} pages · markdown</div>
<h1 class="rise">모든 기록이<br><em>한곳에서 자라는 곳.</em></h1>
<p class="sub rise">마크다운 파일 하나가 문서 하나. 빠르게 쓰고, 링크로 잇고, 바로 찾으세요.</p>
<div class="cta rise"><a class="pill solid" href="/w/Home">문서 보기 →</a><a class="pill big" href="/new?name=${encodeURIComponent('새 문서')}">+ 새 문서 쓰기</a></div>
<form class="search rise" action="/search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input name="q" placeholder="문서 검색…" autocomplete="off"></form>
</section>
<section class="pages"><h2>Pages</h2><div class="grid">${cards.join('')}</div></section>
<section class="feat">
<div><span class="k">[[ ]]</span><strong>위키 링크</strong><span><code>[[페이지명]]</code>으로 문서끼리 바로 연결돼요.</span></div>
<div><span class="k">.md</span><strong>그냥 파일</strong><span>DB 없이 마크다운 파일로 저장돼서 git으로 관리돼요.</span></div>
<div><span class="k">⌕</span><strong>전체 검색</strong><span>제목과 본문을 한 번에 찾아요.</span></div>
</section>
<footer><span>pipaya docs</span><span>hono · markdown-it</span></footer></html>`
}

app.get('/', async (c) => c.html(await landing()))

app.get('/new', (c) => {
  const n = (c.req.query('name') || '').trim()
  return validName(n) ? c.redirect(`/w/${encodeURIComponent(n)}/edit`) : c.redirect('/')
})

app.get('/search', async (c) => {
  const raw = (c.req.query('q') || '').trim()
  const q = raw.toLowerCase()
  const hits = []
  if (q) for (const n of await list()) {
    const t = await fs.readFile(file(n), 'utf8')
    const i = t.toLowerCase().indexOf(q)
    if (n.toLowerCase().includes(q) || i >= 0) {
      const snip = i >= 0 ? t.slice(Math.max(0, i - 40), i + 100).replace(/\s+/g, ' ') : ''
      const hl = esc(snip).replace(new RegExp(esc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`)
      hits.push(`<li><a href="/w/${encodeURIComponent(n)}">${esc(n)}<small>${hl}</small></a></li>`)
    }
  }
  return c.html(await layout('검색', `<div class="top"><span class="crumb"><a href="/">pipaya docs</a> / 검색</span><span>${hits.length}건</span></div><article><h1>“${esc(raw)}”</h1></article><ul class="results">${hits.join('') || '<li class="empty">결과 없음</li>'}</ul>`, raw))
})

app.get('/w/:name', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  let text
  try { text = await fs.readFile(file(name), 'utf8') } catch { return c.redirect(`/w/${encodeURIComponent(name)}/edit`) }
  const { html, tocHtml } = await render(text)
  const bar = `<div class="top"><span class="crumb"><a href="/">pipaya docs</a> / ${esc(name)}</span><a class="btn" href="/w/${encodeURIComponent(name)}/edit">✏️ 편집</a></div>`
  return c.html(await layout(name, bar + '<article>' + html + '</article>', '', name, tocHtml))
})

app.get('/w/:name/edit', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  const text = await fs.readFile(file(name), 'utf8').catch(() => `# ${name}\n\n`)
  return c.html(await layout(`편집: ${name}`, `<div class="top"><span class="crumb"><a href="/">pipaya docs</a> / ${esc(name)} / 편집</span></div>
<form method="post"><textarea name="text" autofocus>${esc(text)}</textarea><div class="actions"><button class="btn primary big">저장</button><a class="btn big" href="/w/${encodeURIComponent(name)}">취소</a></div></form>`, '', name))
})

app.post('/w/:name/edit', async (c) => {
  const name = c.req.param('name')
  if (!validName(name)) return c.text('잘못된 이름', 400)
  const { text } = await c.req.parseBody()
  await fs.writeFile(file(name), String(text ?? '').replace(/\r\n/g, '\n'))
  return c.redirect(`/w/${encodeURIComponent(name)}`, 303)
})

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (i) => console.log(`wiki on :${i.port}`))
