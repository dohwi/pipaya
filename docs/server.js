import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { trimTrailingSlash } from 'hono/trailing-slash'
import { serveStatic } from '@hono/node-server/serve-static'
import MarkdownIt from 'markdown-it'
import container from 'markdown-it-container'
import Prism from 'prismjs'
import loadLanguages from 'prismjs/components/index.js'
import { promises as fs, existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGS, NAV, REPO, UI } from './site.js'

// 읽기 전용 문서 서버. 페이지 생성·편집 경로는 없다(내용은 pages/<lang>/*.md, 구성은 site.js).
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PAGES = path.join(ROOT, 'pages')
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT || 8800)

loadLanguages(['bash', 'json', 'yaml', 'typescript', 'javascript', 'diff', 'ini', 'toml', 'docker', 'powershell', 'css', 'markup', 'jsx', 'tsx'])
const ALIAS = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', yml: 'yaml', ts: 'typescript', js: 'javascript', ps1: 'powershell', dockerfile: 'docker', html: 'markup', svelte: 'markup', env: 'ini' }

// 본문 이미지의 실제 크기(PNG IHDR). <img>에 width/height를 넣어 lazy 로드 전에도 높이가 잡히게 한다
// (없으면 언어 전환·스크롤 중 이미지가 뒤늦게 로드되며 문서가 늘어나 읽던 위치가 밀린다).
const DIMS = new Map()
function pngSize(src) {
  if (DIMS.has(src)) return DIMS.get(src)
  let d = null
  try {
    const f = path.join(PUBLIC, src.replace(/^\/assets\//, ''))
    if (f.startsWith(PUBLIC + path.sep) && f.endsWith('.png')) {
      const b = Buffer.alloc(24), fd = openSync(f, 'r')
      try { readSync(fd, b, 0, 24, 0) } finally { closeSync(fd) }
      if (b.toString('latin1', 1, 4) === 'PNG') d = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    }
  } catch {}
  DIMS.set(src, d)
  return d
}
const dimAttr = (src) => { const d = pngSize(src); return d ? ` width="${d.w}" height="${d.h}"` : '' }
// 문서가 기준으로 하는 pipaya 버전. 릴리스 때 scripts/bump-version.ts가 올리는 server/package.json 값을 그대로 쓴다.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, '..', 'server', 'package.json'), 'utf8')).version || '' } catch { return '' }
})()
const enc = encodeURIComponent
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const PAGE_LIST = NAV.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })))
const IDS = PAGE_LIST.map((p) => p.id)
const BY_ID = new Map(PAGE_LIST.map((p) => [p.id, p]))
const homeOf = (lang) => LANGS[lang].base || '/'
const pageOf = (lang, id) => `${LANGS[lang].base}/w/${enc(id)}`
const HAS = (lang, id) => existsSync(path.join(PAGES, lang, id + '.md'))
const docLink = (lang, id) => (HAS(lang, id) ? pageOf(lang, id) : pageOf('ko', id))
const imgSrc = (lang, name, light = false) => `/assets/img/landing${lang === 'en' ? '/en' : ''}/${name}${light ? '.light' : ''}.png`
const img = (lang, name) => imgSrc(lang, name)
// 다크·라이트 두 벌: 현재 테마에 맞는 쪽만 CSS로 보인다. both=true면 한 장짜리(두 테마가 한 화면에 들어 있는 컷)
const themed = (lang, name, alt, { w, h, lazy = true, both = false } = {}) => {
  const a = `alt="${esc(alt)}"${w ? ` width="${w}" height="${h}"` : ''}${lazy ? ' loading="lazy"' : ' fetchpriority="high"'} decoding="async"`
  return both ? `<img src="${imgSrc(lang, name)}" ${a}>` : `<img class="th-dark" src="${imgSrc(lang, name)}" ${a}><img class="th-light" src="${imgSrc(lang, name, true)}" ${a}>`
}
// 기기 프레임: 스크린샷은 그대로 두고 CSS로 베젤·힌지·그림자를 씌운다. kind: laptop | tablet | window | phone
const device = (kind, inner) => kind === 'shot' ? `<div class="dv dv--shot">${inner}</div>` : kind === 'laptop'
  ? `<div class="dv dv--laptop"><div class="dv-lid"><div class="dv-screen">${inner}</div></div><div class="dv-base"></div></div>`
  : kind === 'tablet'
    ? `<div class="dv dv--tablet"><div class="dv-screen">${inner}</div></div>`
    : kind === 'window'
      ? `<div class="dv dv--window"><div class="dv-bar"><i></i><i></i><i></i></div><div class="dv-screen">${inner}</div></div>`
      : `<div class="dv dv--phone">${inner}</div>`
const otherLang = (lang) => (lang === 'ko' ? 'en' : 'ko')
const bothLangs = (fn) => Object.fromEntries(Object.keys(LANGS).map((k) => [k, fn(k)]))

// ───────────────────────── markdown ─────────────────────────

const VARIANT = { NOTE: 'default', INFO: 'info', TIP: 'success', WARNING: 'warning', DANGER: 'destructive' }
const KEY_NAMES = { Mod: 'Ctrl/⌘', Escape: 'Esc', Backslash: '\\', Backquote: '`', Comma: ',', Space: 'Space' }

function wikilinks(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const s = state.src
    const pos = state.pos
    if (s.charCodeAt(pos) !== 0x5b || s.charCodeAt(pos + 1) !== 0x5b) return false
    const end = s.indexOf(']]', pos + 2)
    if (end < 0) return false
    const [slug, label] = s.slice(pos + 2, end).split('|').map((x) => x.trim())
    if (!slug || slug.includes('\n')) return false
    if (!silent) {
      const lang = state.env.lang
      const page = BY_ID.get(slug)
      if (!page) throw new Error(`unknown wiki link [[${slug}]] in ${state.env.file}`)
      const open = state.push('link_open', 'a', 1)
      open.attrs = [['href', pageOf(lang, slug)]]
      state.push('text', '', 0).content = label || page.title[lang]
      state.push('link_close', 'a', -1)
    }
    state.pos = end + 2
    return true
  })
}

function keys(md) {
  md.inline.ruler.before('emphasis', 'kbd', (state, silent) => {
    const s = state.src
    const pos = state.pos
    if (s.charCodeAt(pos) !== 0x7b || s.charCodeAt(pos + 1) !== 0x7b) return false
    const end = s.indexOf('}}', pos + 2)
    if (end < 0) return false
    const body = s.slice(pos + 2, end).trim()
    if (!body || body.includes('\n')) return false
    if (!silent) state.push('kbd', '', 0).content = body
    state.pos = end + 2
    return true
  })
  md.renderer.rules.kbd = (tokens, i) => {
    const parts = tokens[i].content.split('+').map((k) => k.trim()).filter(Boolean)
    return `<span class="keys">${parts.map((k) => `<kbd>${esc(KEY_NAMES[k] ?? k)}</kbd>`).join('<span class="plus">+</span>')}</span>`
  }
}

function callouts(md) {
  const marker = /^\[!(NOTE|INFO|TIP|WARNING|DANGER)\][ \t]*/
  md.core.ruler.push('callouts', (state) => {
    const t = state.tokens
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'blockquote_open') continue
      const inl = t[i + 2]
      if (t[i + 1]?.type !== 'paragraph_open' || inl?.type !== 'inline') continue
      const m = marker.exec(inl.content)
      if (!m) continue
      let depth = 0
      let j = i
      for (; j < t.length; j++) {
        if (t[j].type === 'blockquote_open') depth++
        if (t[j].type === 'blockquote_close' && --depth === 0) break
      }
      const kind = m[1]
      t[i].tag = 'div'
      t[i].attrSet('class', `ui-alert ui-alert--${VARIANT[kind]} callout`)
      t[i].attrSet('role', 'note')
      t[j].tag = 'div'
      inl.content = inl.content.slice(m[0].length)
      const c = inl.children
      if (c?.[0]?.type === 'text') {
        c[0].content = c[0].content.replace(marker, '')
        if (!c[0].content) c.shift()
        if (c[0]?.type === 'softbreak') c.shift()
      }
      const title = new state.Token('callout_title', '', 0)
      title.meta = kind
      t.splice(i + 1, 0, title)
    }
  })
  md.renderer.rules.callout_title = (tokens, i, o, env) => `<div class="ui-alert-title">${esc(UI[env.lang].callouts[tokens[i].meta])}</div>\n`
}

function blocks(md) {
  md.renderer.rules.fence = (tokens, i, o, env) => {
    const t = tokens[i]
    const info = t.info.trim().split(/\s+/)[0].toLowerCase()
    const lang = ALIAS[info] || info
    const code = t.content.replace(/\n$/, '')
    const grammar = Prism.languages[lang]
    const html = grammar ? Prism.highlight(code, grammar, lang) : esc(code)
    const label = info && info !== 'text' ? info : ''
    const u = UI[env.lang]
    return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(label)}</span><button type="button" class="code-copy" data-copy data-done="${esc(u.copied)}">${esc(u.copy)}</button></div><pre tabindex="0"><code class="language-${esc(lang || 'text')}">${html}</code></pre></div>\n`
  }
  // 이미지: ![캡션](경로) → 클릭하면 확대되는 figure. 캡션은 alt 텍스트를 그대로 쓴다.
  md.renderer.rules.image = (tokens, i, o, env) => {
    const t = tokens[i]
    const src = t.attrGet('src') || ''
    const alt = t.content
    // 앱 스크린샷(/assets/img/ui/…)은 다크·라이트 두 벌이 있다. 현재 테마에 맞는 쪽만 CSS로 보여 준다.
    const themed = /^\/assets\/img\/ui\/.+\.png$/.test(src)
    const light = themed ? src.replace(/\.png$/, '.light.png') : ''
    const imgs = themed
      ? `<img class="th-dark" src="${esc(src)}"${dimAttr(src)} alt="${esc(alt)}" loading="lazy" decoding="async"><img class="th-light" src="${esc(light)}"${dimAttr(light)} alt="${esc(alt)}" loading="lazy" decoding="async">`
      : `<img src="${esc(src)}"${dimAttr(src)} alt="${esc(alt)}" loading="lazy" decoding="async">`
    return `<figure class="shot"><button type="button" class="shot-zoom" data-zoom="${esc(src)}"${themed ? ` data-zoom-light="${esc(light)}"` : ''} aria-label="${esc(UI[env.lang].zoom)}: ${esc(alt)}">${imgs}</button>${alt ? `<figcaption>${esc(alt)}</figcaption>` : ''}</figure>`
  }
  md.renderer.rules.table_open = () => '<div class="ui-table-container" tabindex="0"><table class="ui-table">\n'
  md.renderer.rules.table_close = () => '</table></div>\n'
  md.renderer.rules.th_open = (tokens, i, o, env, self) => `<th class="ui-table-head"${self.renderAttrs(tokens[i])}>`
  md.renderer.rules.td_open = (tokens, i, o, env, self) => `<td class="ui-table-cell"${self.renderAttrs(tokens[i])}>`
  const link = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
  md.renderer.rules.link_open = (tokens, i, o, env, self) => {
    const href = tokens[i].attrGet('href') || ''
    if (/^https?:\/\//.test(href)) {
      tokens[i].attrSet('target', '_blank')
      tokens[i].attrSet('rel', 'noopener noreferrer')
      tokens[i].attrJoin('class', 'external')
    }
    return link(tokens, i, o, env, self)
  }
  md.renderer.rules.heading_open = (tokens, i, o, env, self) => {
    const t = tokens[i]
    const id = t.attrGet('id')
    return `<${t.tag}${self.renderAttrs(t)}>${id ? `<a class="anchor" href="#${esc(id)}">` : ''}`
  }
  md.renderer.rules.heading_close = (tokens, i) => {
    const open = tokens.slice(0, i).reverse().find((x) => x.type === 'heading_open')
    return `${open?.attrGet('id') ? '</a>' : ''}</${tokens[i].tag}>\n`
  }
  const box = (name, open, close) =>
    md.use(container, name, {
      validate: (p) => new RegExp(`^${name}(\\s|$)`).test(p.trim()),
      render: (tokens, i) => (tokens[i].nesting === 1 ? open(tokens[i].info.trim().slice(name.length).trim()) : close),
    })
  box('cards', () => '<div class="cards">\n', '</div>\n')
  box('steps', () => '<div class="steps">\n', '</div>\n')
  box('tabs', () => '<div class="tabs">\n', '</div>\n')
  box('details', (title) => `<details class="ui-accordion"><summary class="ui-accordion-trigger">${esc(title)}</summary><div class="ui-accordion-body">\n`, '</div></details>\n')
}

const md = new MarkdownIt({ linkify: true }) // html 비허용
md.use(wikilinks).use(keys).use(callouts).use(blocks)

const slug = (t) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'
const plain = (inline) => (inline.children || []).map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : c.type === 'softbreak' ? ' ' : c.type === 'kbd' ? c.content : '')).join('')

function compile(lang, id, text) {
  const env = { lang, file: `${lang}/${id}.md` }
  const tokens = md.parse(text, env)
  const toc = []
  const sections = [{ id: '', title: '', text: '' }]
  const seen = new Map()
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open' && (t.tag === 'h2' || t.tag === 'h3')) {
      const title = plain(tokens[i + 1])
      let hid = slug(title)
      const k = seen.get(hid) || 0
      seen.set(hid, k + 1)
      if (k) hid += '-' + k
      t.attrSet('id', hid)
      toc.push({ id: hid, title, level: t.tag })
      sections.push({ id: hid, title, text: '' })
    } else if (t.type === 'inline' && tokens[sections.length ? Math.max(0, i - 1) : 0]?.type !== 'heading_open') {
      sections.at(-1).text += plain(t) + ' '
    } else if (t.type === 'fence') {
      sections.at(-1).text += t.content.replace(/\s+/g, ' ') + ' '
    }
  })
  const html = md.renderer.render(tokens, md.options, env)
  return { html, toc, sections: sections.filter((s) => s.text.trim() || s.title).map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })) }
}

// 파일 mtime으로 캐시: md를 고치면 재시작 없이 반영된다.
const cache = new Map()
async function readPage(lang, id) {
  if (!BY_ID.has(id)) return null // 목록에 없는 이름은 파일 시스템에 닿지 않는다
  const file = path.join(PAGES, lang, id + '.md')
  let stat
  try { stat = await fs.stat(file) } catch { return null }
  const key = `${lang}/${id}`
  const hit = cache.get(key)
  if (hit && hit.mtime === stat.mtimeMs) return hit.page
  const page = compile(lang, id, await fs.readFile(file, 'utf8'))
  cache.set(key, { mtime: stat.mtimeMs, page })
  return page
}

const version = {}
async function assetVersion(name) {
  try { return String(Math.floor((await fs.stat(path.join(name.startsWith('style') ? ROOT : PUBLIC, name))).mtimeMs)) } catch { return '0' }
}

// ───────────────────────── html ─────────────────────────

const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  moon: '<svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>',
  sun: '<svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>',
}
const THEME_JS = `document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')`
const PRELOAD = ['manrope-variable', 'suit-variable'].map((f) => `<link rel="preload" href="/assets/fonts/${f}.woff2" as="font" type="font/woff2" crossorigin>`).join('')

async function head(lang, title, description, alt) {
  const [css, js] = await Promise.all([assetVersion('style.css'), assetVersion('nav.js')])
  version.js = js
  const links = Object.keys(LANGS).map((k) => `<link rel="alternate" hreflang="${k}" href="${alt[k]}">`).join('')
  return `<!doctype html><html lang="${lang}" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="color-scheme" content="light dark">${links}
<link rel="icon" href="/assets/img/favicon.svg">${PRELOAD}<link rel="stylesheet" href="/style.css?v=${css}">
<script>${THEME_JS}</script>`
}

function clientStrings(lang) {
  const u = UI[lang]
  return `<script type="application/json" id="i18n">${JSON.stringify({ base: LANGS[lang].base, searchPh: u.searchPh, hint: u.searchHint, empty: u.searchEmpty, start: u.searchStart, close: u.close, zoomClose: u.zoomClose, search: u.search, menu: u.menu })}</script>`
}

function topbar(lang, alt, { docs = true } = {}) {
  const u = UI[lang]
  const o = otherLang(lang)
  return `<a class="skip-link" href="#content">${u.skip}</a>
<header class="topbar${docs ? '' : ' topbar--landing'}"><div class="topbar-inner">
<div class="topbar-start">${docs ? `<button type="button" class="ui-button ui-button--ghost ui-button-size--icon menu-trigger" data-menu aria-label="${u.menu}" aria-controls="side" aria-expanded="false"><span class="ui-button-icon">${ICON.menu}</span></button>` : ''}
<a class="brand" href="${homeOf(lang)}"><img class="dark" src="/assets/img/pipaya-dark.svg" alt=""><img class="light" src="/assets/img/pipaya-light.svg" alt=""><span>pipaya</span><span class="brand-sub">docs</span>${APP_VERSION ? `<span class="brand-ver" title="${esc(u.versionTip.replace('{v}', APP_VERSION))}">v${esc(APP_VERSION)}</span>` : ''}</a>
<nav class="topnav" aria-label="${u.docs}">${docs
  ? `<a class="topnav-link active" href="${pageOf(lang, 'overview')}" aria-current="page">${u.docs}</a><a class="topnav-link" href="${pageOf(lang, 'installation')}">${u.install}</a>`
  : `<a class="topnav-link" href="${pageOf(lang, 'overview')}">${u.wiki}</a><a class="topnav-link" href="#install">${u.install}</a>`}</nav></div>
<div class="topbar-actions">
${docs ? `<button type="button" class="search-trigger" data-search aria-haspopup="dialog">${ICON.search}<span class="search-label">${u.search}</span><span class="search-shortcut" data-shortcut>Ctrl K</span></button>` : ''}
<a class="ui-button ui-button--ghost ui-button-size--icon lang-trigger" data-lang-switch href="${alt[o]}" hreflang="${o}" lang="${o}" title="${u.switchTo}" aria-label="${u.switchTo}"><span class="ui-button-icon lang-mark">${u.switchLabel}</span></a>
<a class="ui-button ui-button--ghost ui-button-size--icon" href="${REPO}" target="_blank" rel="noopener noreferrer" aria-label="${u.repo}" title="${u.repo}"><span class="ui-button-icon">${ICON.github}</span></a>
<button type="button" class="ui-button ui-button--ghost ui-button-size--icon" data-theme-toggle aria-label="${u.theme}" title="${u.theme}"><span class="ui-button-icon">${ICON.moon}${ICON.sun}</span></button>
</div></div></header>`
}

function sidebar(lang, active) {
  const items = NAV.map((g) => `<div class="nav-group"><div class="nav-group-title">${esc(g.title[lang])}</div>${g.pages.map((p) => `<a class="nav-link${p.id === active ? ' active' : ''}" href="${pageOf(lang, p.id)}"${p.id === active ? ' aria-current="page"' : ''}>${esc(p.title[lang])}</a>`).join('')}</div>`).join('')
  return `<aside class="sidebar" id="side"><nav class="component-navigation" aria-label="${UI[lang].docs}">${items}</nav></aside><div class="drawer-overlay" data-menu-close></div>`
}

function pager(lang, id) {
  const i = IDS.indexOf(id)
  const u = UI[lang]
  const chev = (d) => `<svg class="pager-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
  const link = (n, cls, label) => {
    if (!n) return '<span></span>'
    const p = BY_ID.get(n)
    const ico = chev(cls === 'prev' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6')
    return `<a class="pager-link ${cls}" href="${pageOf(lang, n)}" rel="${cls}"><span class="pager-text"><small>${label}</small><b>${esc(p.title[lang])}</b></span>${ico}</a>`
  }
  const keys = esc(u.keys).replace('← →', '<kbd>←</kbd><kbd>→</kbd>')
  return `<nav class="pager" aria-label="${u.docs}">${link(IDS[i - 1], 'prev', u.prev)}${link(IDS[i + 1], 'next', u.next)}</nav><p class="keyhint">${keys}</p>`
}

function docMain(lang, id, page) {
  const p = BY_ID.get(id)
  const u = UI[lang]
  const toc = page.toc.length > 1 ? `<aside class="toc" aria-label="${u.toc}"><div class="toc-title">${u.toc}</div>${page.toc.map((x) => `<a class="${x.level === 'h3' ? 'l3' : ''}" href="#${x.id}">${esc(x.title)}</a>`).join('')}</aside>` : ''
  const crumbs = `<nav class="ui-breadcrumb" aria-label="breadcrumb"><ol class="ui-breadcrumb-list"><li class="ui-breadcrumb-item"><a class="ui-breadcrumb-link" href="${homeOf(lang)}">pipaya</a></li><li class="ui-breadcrumb-separator" aria-hidden="true">/</li><li class="ui-breadcrumb-item">${esc(p.group[lang])}</li><li class="ui-breadcrumb-separator" aria-hidden="true">/</li><li class="ui-breadcrumb-item"><span class="ui-breadcrumb-page" aria-current="page">${esc(p.title[lang])}</span></li></ol></nav>`
  return `<main class="main" id="content" data-doc data-page="${esc(id)}" tabindex="-1"><div class="doc-grid"><div class="doc">${crumbs}<article class="prose"><p class="doc-eyebrow">pipaya</p><h1 tabindex="-1">${esc(p.title[lang])}</h1><p class="lead">${esc(p.desc[lang])}</p>${page.html}</article>${pager(lang, id)}</div>${toc}</div></main>`
}

async function docPage(lang, id, page) {
  const p = BY_ID.get(id)
  const alt = bothLangs((k) => pageOf(k, id))
  const title = `${p.title[lang]} · pipaya docs`
  return `${await head(lang, title, p.desc[lang], alt)}
${topbar(lang, alt)}${sidebar(lang, id)}${docMain(lang, id, page)}${clientStrings(lang)}<script src="/assets/nav.js?v=${version.js}" defer></script></html>`
}

const RELEASE = 'https://github.com/dohwi/pipaya/releases'
const CLIENTS = [['Windows', 'pipaya-windows-x64-setup.exe'], ['macOS', 'pipaya-macos-arm64.dmg'], ['Android', 'pipaya-android-arm64.apk'], ['iOS', 'pipaya-ios-arm64-unsigned.ipa']]

async function landing(lang) {
  const u = UI[lang]
  const L = u.land
  const alt = bothLangs((k) => homeOf(k))
  const install = 'curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash'
  const code = `<div class="code-block"><div class="code-head"><span class="code-lang">bash</span><button type="button" class="code-copy" data-copy data-done="${esc(u.copied)}">${esc(u.copy)}</button></div><pre tabindex="0"><code class="language-bash">${Prism.highlight(install, Prism.languages.bash, 'bash')}</code></pre></div>`
  const win = 'irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 | iex'
  const winCode = `<div class="code-block"><div class="code-head"><span class="code-lang">powershell</span><button type="button" class="code-copy" data-copy data-done="${esc(u.copied)}">${esc(u.copy)}</button></div><pre tabindex="0"><code>${esc(win)}</code></pre></div>`
  return `${await head(lang, 'pipaya docs', L.sub, alt)}
${topbar(lang, alt, { docs: false })}
<main class="landing" id="content" tabindex="-1">
<section class="hero">
<img class="mascot dark" src="/assets/img/pipaya-dark.svg" alt="pipaya"><img class="mascot light" src="/assets/img/pipaya-light.svg" alt="pipaya">
<p class="hero-name">Pipaya</p>
<h1>${esc(L.h1)}</h1>
<p class="hero-sub">${esc(L.sub)}</p>
<div class="hero-cta"><a class="ui-button ui-button--default ui-button-size--lg" href="#install">${esc(L.cta1)}</a><a class="ui-button ui-button--outline ui-button-size--lg" href="${pageOf(lang, 'overview')}">${esc(L.cta2)}</a></div>
</section>
<section class="demo-stage" aria-label="${esc(L.demoTitle)}"><div id="demo" class="demo"><noscript>JavaScript required.</noscript></div>
<p class="demo-hint">${esc(L.demoSub)}</p>
<script type="application/json" id="demo-data">${JSON.stringify({ ...L.demo, orch: L.show.orch }).replace(/</g, '\\u003c')}</script></section>

<section class="band"><div class="band-inner"><h2>${esc(L.orchTitle)}</h2><p class="band-sub">${esc(L.orchSub)}</p><div class="orch" id="orch"><figure class="wide-shot">${device('shot', themed(lang, 'orch', L.orchTitle, { w: 1800, h: 1173 }))}</figure></div><ul class="points points--row">${L.orchPoints.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('')}</ul><p class="center"><a class="ui-button ui-button--outline ui-button-size--default" href="${docLink(lang, 'orchestration')}">${esc(L.orchMore)}</a></p></div></section>

<section class="band" id="install"><div class="band-inner install"><h2>${esc(L.installTitle)}</h2>
<h3 class="install-step"><span>1</span>${esc(L.clientStep)}</h3>
<div class="install-clients">${CLIENTS.map(([n, f]) => `<a class="ui-button ui-button--outline ui-button-size--default" href="${RELEASE}${f ? '/download/latest/' + f : ''}" rel="noopener">${n}</a>`).join('')}</div>
${winCode}<p class="muted">${esc(L.clientNote)} <a href="${docLink(lang, 'installation')}">${esc(L.installMore)}</a></p>
<h3 class="install-step"><span>2</span>${esc(L.serverStep)}</h3>${code}<p class="muted">${esc(L.installNote)}</p></div></section>
</main>
<footer class="site-footer"><span>pipaya docs</span><span>${esc(u.footer)}</span></footer>
${clientStrings(lang)}<script src="/assets/nav.js?v=${version.js}" defer></script><script src="/assets/demo.js?v=${await assetVersion('demo.js')}" defer></script><script src="/assets/orch.js?v=${await assetVersion('orch.js')}" defer></script></html>`
}

// ───────────────────────── routes ─────────────────────────

const app = new Hono()
app.use(trimTrailingSlash())
app.use('/style.css', async (c) => c.body(await fs.readFile(path.join(ROOT, 'style.css')), 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }))
app.use('/assets/*', async (c, next) => {
  await next()
  if (c.req.path.startsWith('/assets/fonts/')) c.header('Cache-Control', 'public, max-age=31536000, immutable')
  else c.header('Cache-Control', 'no-cache')
})
app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), PUBLIC) || '.', rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }))

app.get('/search.json', async (c) => {
  const lang = c.req.query('lang') in LANGS ? c.req.query('lang') : 'ko'
  const out = []
  for (const p of PAGE_LIST) {
    const page = await readPage(lang, p.id)
    if (!page) continue
    out.push({ id: p.id, title: p.title[lang], group: p.group[lang], desc: p.desc[lang], url: pageOf(lang, p.id), sections: page.sections })
  }
  return c.json(out, 200, { 'Cache-Control': 'no-cache' })
})

function mount(lang) {
  const base = LANGS[lang].base
  const u = UI[lang]

  app.get(base || '/', async (c) => c.html(await landing(lang)))

  app.get(base + '/search', async (c) => {
    const raw = (c.req.query('q') || '').trim().slice(0, 200)
    const q = raw.toLowerCase()
    const hits = []
    if (q) for (const p of PAGE_LIST) {
      const page = await readPage(lang, p.id)
      const hay = [p.title[lang], p.desc[lang], ...(page?.sections.map((s) => `${s.title} ${s.text}`) ?? [])].join(' ')
      const i = hay.toLowerCase().indexOf(q)
      if (i >= 0) {
        const snip = hay.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, ' ')
        const hl = esc(snip).replace(new RegExp(esc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`)
        hits.push(`<li><a href="${pageOf(lang, p.id)}"><b>${esc(p.title[lang])}</b><small>${hl}</small></a></li>`)
      }
    }
    const alt = bothLangs((k) => `${LANGS[k].base}/search${raw ? '?q=' + enc(raw) : ''}`)
    const body = `<main class="main" id="content" tabindex="-1"><div class="doc-grid"><div class="doc"><article class="prose"><h1>${u.searchTitle}</h1><p class="lead">“${esc(raw)}” · ${u.results(hits.length)}</p><ul class="results">${hits.join('') || `<li class="empty">${u.none}</li>`}</ul></article></div></div></main>`
    return c.html(`${await head(lang, u.searchTitle + ' · pipaya docs', u.searchTitle, alt)}${topbar(lang, alt)}${sidebar(lang, '')}${body}${clientStrings(lang)}<script src="/assets/nav.js?v=${version.js}" defer></script></html>`)
  })

  app.get(base + '/w/:id', async (c) => {
    const id = c.req.param('id')
    const page = await readPage(lang, id)
    if (!page) {
      const alt = bothLangs((k) => homeOf(k))
      const body = `<main class="main" id="content" tabindex="-1"><div class="doc-grid"><div class="doc"><article class="prose"><h1>404</h1><p class="lead">${u.notFound}</p><p><a href="${homeOf(lang)}">${u.toHome}</a></p></article></div></div></main>`
      return c.html(`${await head(lang, '404 · pipaya docs', u.notFound, alt)}${topbar(lang, alt)}${sidebar(lang, '')}${body}${clientStrings(lang)}<script src="/assets/nav.js?v=${version.js}" defer></script></html>`, 404)
    }
    return c.html(await docPage(lang, id, page))
  })
}
for (const lang of Object.keys(LANGS)) mount(lang)

// 시작할 때 모든 페이지를 한 번 컴파일해 깨진 [[링크]]나 누락된 파일을 바로 드러낸다.
const problems = []
for (const lang of Object.keys(LANGS)) for (const id of IDS) {
  try { if (!(await readPage(lang, id))) problems.push(`missing pages/${lang}/${id}.md`) } catch (e) { problems.push(`${lang}/${id}: ${e.message}`) }
}
if (problems.length) console.warn(`docs: ${problems.length} problem(s)\n  ` + problems.join('\n  '))

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (i) => console.log(`wiki on :${i.port} · ${IDS.length} pages × ${Object.keys(LANGS).length} languages`))
