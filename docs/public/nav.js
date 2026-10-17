// 문서 사이트 동작. 읽기 전용이며 JS가 없어도 모든 링크는 일반 이동으로 동작한다.
// - 사이드바·이전/다음·← → 이동은 페이지 전체를 새로 불러오지 않고 본문만 바꾼다(깜빡임 방지)
// - 검색(Ctrl/⌘ K, /), 테마 전환, 코드 복사, 모바일 메뉴, 목차 강조, 선택 표시 이동
;(() => {
  const root = document.documentElement
  let I = JSON.parse(document.getElementById('i18n')?.textContent || '{}')
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const docPath = /^\/(en\/)?w\/[^/]+$/
  const langOf = (p) => (p.startsWith('/en/') || p === '/en' ? 'en' : 'ko')
  const isDoc = (u) => u.origin === location.origin && docPath.test(u.pathname)

  const shortcuts = () => document.querySelectorAll('[data-shortcut]').forEach((el) => (el.textContent = isMac ? '⌘ K' : 'Ctrl K'))
  shortcuts()

  // ── 테마 ──
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-theme-toggle]')
    if (!t) return
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    // 색 전환을 잠깐 끄고 모든 요소가 같은 프레임에 바뀌게 한다 (style.css의 .theme-switching)
    root.classList.add('theme-switching')
    root.dataset.theme = next
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
    try { localStorage.theme = next } catch {}
  })

  // ── 코드 복사 ──
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-copy]')
    if (!b) return
    const code = b.closest('.code-block')?.querySelector('code')
    if (!code) return
    const text = code.textContent
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text })
      document.body.append(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove()
    }
    const old = b.textContent
    b.textContent = b.dataset.done || old
    clearTimeout(b._t)
    b._t = setTimeout(() => (b.textContent = old), 1400)
  })

  // ── 모바일 메뉴 ──
  const setMenu = (open) => {
    document.body.classList.toggle('menu-open', open)
    document.body.toggleAttribute('data-scroll-locked', open)
    const btn = document.querySelector('[data-menu]')
    btn?.setAttribute('aria-expanded', String(open))
    if (open) document.querySelector('.nav-link.active')?.focus({ preventScroll: true })
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-menu]')) setMenu(!document.body.classList.contains('menu-open'))
    else if (e.target.closest?.('[data-menu-close]')) setMenu(false)
  })

  // ── 사이드바 선택 표시(하나의 배경이 이동) ──
  function indicator(animate) {
    const nav = document.querySelector('.component-navigation')
    if (!nav) return
    const active = nav.querySelector('.nav-link.active')
    let el = nav.querySelector('.navigation-indicator')
    if (!active) { el?.remove(); nav.removeAttribute('data-indicator-ready'); return }
    if (!el) { el = document.createElement('span'); el.className = 'navigation-indicator'; el.setAttribute('aria-hidden', 'true'); nav.prepend(el) }
    const n = nav.getBoundingClientRect()
    const r = active.getBoundingClientRect()
    if (!animate || reduce()) el.style.transition = 'none'
    el.style.width = r.width + 'px'
    el.style.height = r.height + 'px'
    el.style.transform = `translate(${r.left - n.left}px, ${r.top - n.top}px)`
    if (!animate || reduce()) { el.offsetWidth; el.style.transition = '' }
    nav.setAttribute('data-indicator-ready', '')
  }
  const placeIndicator = () => {
    indicator(false)
    document.querySelector('.nav-link.active')?.scrollIntoView({ block: 'nearest' })
  }

  // ── 목차 강조 ──
  let tocObserver
  function toc() {
    tocObserver?.disconnect()
    const links = [...document.querySelectorAll('.toc a')]
    if (!links.length) return
    const map = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]))
    const heads = [...map.keys()].map((id) => document.getElementById(id)).filter(Boolean)
    const mark = (id) => links.forEach((a) => a.classList.toggle('active', a === map.get(id)))
    tocObserver = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (seen) mark(seen.target.id)
    }, { rootMargin: '-72px 0px -70% 0px' })
    heads.forEach((h) => tocObserver.observe(h))
  }

  // ── 페이지 전환(본문만 교체) ──
  const cache = new Map()
  const load = (pathname) => {
    if (!cache.has(pathname)) {
      cache.set(pathname, fetch(pathname).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text() }).catch((e) => { cache.delete(pathname); throw e }))
    }
    return cache.get(pathname)
  }
  const warm = (href) => { const u = new URL(href, location.href); if (isDoc(u)) load(u.pathname).catch(() => {}) }
  const warmNeighbors = () => document.querySelectorAll('.pager a').forEach((a) => warm(a.href))
  let current = location.pathname

  function syncLang(pathname) {
    const a = document.querySelector('[data-lang-switch]')
    if (!a) return
    a.href = langOf(pathname) === 'en' ? pathname.replace(/^\/en/, '') || '/' : '/en' + pathname
  }

  // 언어 전환 시 읽던 위치 유지: 화면 맨 위에 걸친 본문 블록의 순번과 블록 내 비율을 기억했다가 번역본의 같은 블록에 맞춘다.
  const blocks = () => [...document.querySelectorAll('main .prose > *')]
  const topInset = () => (document.querySelector('header.topbar')?.getBoundingClientRect().height || 0) + 8
  function readAnchor() {
    const list = blocks()
    const inset = topInset()
    let i = list.findIndex((el) => el.getBoundingClientRect().bottom > inset)
    if (i < 0) i = list.length - 1
    if (i < 0) return null
    const r = list[i].getBoundingClientRect()
    return { i, count: list.length, ratio: r.height ? (inset - r.top) / r.height : 0, y: scrollY }
  }
  function restoreAnchor(a) {
    if (!a) return
    const list = blocks()
    if (!list.length || list.length !== a.count) return void scrollTo(0, a.y) // 구조가 다르면 기존 위치 유지
    const r = list[a.i].getBoundingClientRect()
    const ratio = Math.min(Math.max(a.ratio, 0), 1)
    const prev = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'
    scrollTo(0, scrollY + r.top + r.height * ratio - topInset())
    root.style.scrollBehavior = prev
  }

  // 연타 대비: 가장 나중에 시작한 전환만 화면에 반영한다. want = 마지막으로 요청된 경로(화면에 떠 있는 current와 다를 수 있다).
  let seq = 0
  let want = location.pathname
  async function go(href, push) {
    const u = new URL(href, location.href)
    const mine = ++seq
    want = u.pathname
    syncLang(u.pathname) // 응답을 기다리는 동안에도 스위치가 항상 '요청된 쪽의 반대 언어'를 가리키게 한다
    try {
      const html = await load(u.pathname)
      if (mine !== seq) return // 더 새 요청이 시작됨: 늦게 끝난 이전 전환은 버린다
      if (u.pathname === current) { syncLang(current); return } // 왔다 갔다 해서 결국 보던 문서로 돌아옴: 아무것도 바꾸지 않는다
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const next = doc.querySelector('main')
      if (!next) throw new Error('no main')
      const prev = document.querySelector('main')
      const langChanged = langOf(u.pathname) !== langOf(current)
      const anchor = langChanged ? readAnchor() : null
      if (langChanged) {
        // 언어가 바뀌면 상단바·사이드바·번역 문자열·검색 데이터도 함께 교체한다(새로고침 없이 제자리에서).
        for (const sel of ['header.topbar', 'aside.sidebar']) {
          const n = doc.querySelector(sel)
          if (n) document.querySelector(sel)?.replaceWith(document.importNode(n, true))
        }
        const strings = doc.getElementById('i18n')
        if (strings) { document.getElementById('i18n').textContent = strings.textContent; I = JSON.parse(strings.textContent || '{}') }
        root.lang = doc.documentElement.lang
        dialog?.close(); dialog?.remove(); dialog = input = list = data = null; results = []
        shortcuts()
      }
      prev.replaceWith(document.importNode(next, true))
      document.title = doc.title
      document.querySelectorAll('.nav-link').forEach((a) => {
        const on = a.pathname === u.pathname
        a.classList.toggle('active', on)
        on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')
      })
      syncLang(u.pathname)
      setMenu(false)
      // 언어 전환은 같은 글의 번역본이라 히스토리를 쌓지 않고 교체한다(연타해도 '뒤로'가 늘어나지 않는다).
      if (push) history[langChanged ? 'replaceState' : 'pushState'](null, '', u.pathname + u.hash)
      current = u.pathname
      const target = u.hash && document.getElementById(decodeURIComponent(u.hash.slice(1)))
      if (target) target.scrollIntoView()
      else if (langChanged) restoreAnchor(anchor) // 같은 문서의 번역본이므로 보던 블록을 같은 화면 위치에 맞춘다
      else { window.scrollTo(0, 0); document.querySelector('main h1')?.focus({ preventScroll: true }) }
      indicator(!langChanged)
      toc()
      warmNeighbors()
    } catch {
      if (mine === seq) location.href = u.href // 더 새 요청이 있으면 그쪽이 알아서 한다
    }
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target.closest?.('a')
    if (!a || a.target || a.hasAttribute('download')) return
    const u = new URL(a.href, location.href)
    if (!isDoc(u) || !docPath.test(location.pathname)) return
    if (u.pathname === location.pathname && want === location.pathname) return
    e.preventDefault()
    if (u.pathname === want && want !== current) return // 이미 그 문서로 가는 중
    go(u.href, true)
  })
  const hover = (e) => { const a = e.target.closest?.('a'); if (a) warm(a.href) }
  document.addEventListener('mouseover', hover)
  document.addEventListener('touchstart', hover, { passive: true })

  window.addEventListener('popstate', () => {
    if (location.pathname === current) return
    if (docPath.test(location.pathname) && document.querySelector('main[data-doc]')) go(location.href, false)
    else location.reload()
  })

  // ── 검색 ──
  let dialog, input, list, data, results = [], index = 0
  const norm = (s) => s.toLowerCase()
  const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const mark = (text, terms) => {
    let out = escHtml(text)
    for (const t of terms) if (t) out = out.replace(new RegExp(escHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`)
    return out
  }
  function snippet(text, terms) {
    const low = norm(text)
    const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
    const start = Math.max(0, at - 28)
    return (start ? '… ' : '') + text.slice(start, start + 130)
  }
  function search(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const out = []
    for (const p of data) {
      const title = norm(p.title), desc = norm(p.desc)
      const pageHit = terms.every((t) => title.includes(t))
      if (pageHit || terms.every((t) => (title + ' ' + desc).includes(t))) out.push({ score: pageHit ? 100 : 60, p, sec: null, text: p.desc })
      for (const s of p.sections) {
        const st = norm(s.title), body = norm(s.text)
        const all = st + ' ' + body
        if (!terms.every((t) => all.includes(t))) continue
        const score = terms.every((t) => st.includes(t)) ? 80 : terms.every((t) => (title + ' ' + st).includes(t)) ? 70 : 20
        out.push({ score, p, sec: s, text: s.text })
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 14).map((r) => ({ ...r, terms }))
  }
  function render() {
    const q = input.value.trim()
    if (!q) { list.innerHTML = `<li class="search-empty" role="presentation">${escHtml(I.start)}</li>`; results = []; return }
    results = search(q)
    if (!results.length) { list.innerHTML = `<li class="search-empty" role="presentation">${escHtml(I.empty)}</li>`; return }
    index = 0
    list.innerHTML = results.map((r, i) => {
      const href = r.p.url + (r.sec?.id ? '#' + r.sec.id : '')
      const heading = r.sec?.title ? `${r.p.title} › ${r.sec.title}` : r.p.title
      return `<li class="search-item" role="option" id="sr-${i}" aria-selected="${i === 0}"><a href="${href}"><div class="t"><span>${mark(heading, r.terms)}</span><span class="g">${escHtml(r.p.group)}</span></div><div class="s">${mark(snippet(r.text, r.terms), r.terms)}</div></a></li>`
    }).join('')
    input.setAttribute('aria-activedescendant', 'sr-0')
  }
  const select = (i) => {
    if (!results.length) return
    index = (i + results.length) % results.length
    list.querySelectorAll('.search-item').forEach((li, n) => li.setAttribute('aria-selected', String(n === index)))
    input.setAttribute('aria-activedescendant', 'sr-' + index)
    document.getElementById('sr-' + index)?.scrollIntoView({ block: 'nearest' })
  }
  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog')
      dialog.className = 'search-dialog'
      dialog.setAttribute('aria-label', I.search)
      dialog.innerHTML = `<div class="search-box"><div class="search-input-row"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="search-input" type="text" role="combobox" aria-expanded="true" aria-controls="search-list" autocomplete="off" spellcheck="false" placeholder="${escHtml(I.searchPh)}"></div><ul class="search-list" id="search-list" role="listbox"></ul><div class="search-foot">${escHtml(I.hint)}</div></div>`
      document.body.append(dialog)
      input = dialog.querySelector('input')
      list = dialog.querySelector('ul')
      input.addEventListener('input', render)
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) return dialog.close()
        const a = e.target.closest('a')
        if (!a) return
        e.preventDefault(); dialog.close(); nav(a.getAttribute('href'))
      })
      list.addEventListener('mousemove', (e) => { const li = e.target.closest('.search-item'); if (li) select([...list.children].indexOf(li)) })
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return
        if (e.key === 'ArrowDown') { e.preventDefault(); select(index + 1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); select(index - 1) }
        else if (e.key === 'Enter') { e.preventDefault(); const r = results[index]; if (r) { dialog.close(); nav(r.p.url + (r.sec?.id ? '#' + r.sec.id : '')) } }
      })
    }
    if (!data) {
      data = []
      fetch('/search.json?lang=' + langOf(location.pathname)).then((r) => r.json()).then((d) => { data = d; if (input.value) render() }).catch(() => {})
    }
    dialog.showModal()
    input.value = ''
    render()
    input.focus()
  }
  function nav(href) {
    const u = new URL(href, location.href)
    if (isDoc(u) && docPath.test(location.pathname) && u.pathname !== location.pathname) go(u.href, true)
    else if (u.pathname === location.pathname && u.hash) { history.pushState(null, '', u.hash); document.getElementById(decodeURIComponent(u.hash.slice(1)))?.scrollIntoView() }
    else location.href = u.href
  }
  document.addEventListener('click', (e) => { if (e.target.closest?.('[data-search]')) open() })

  // ── 키보드 ──
  const typing = (el) => el?.closest?.('input,textarea,select,[contenteditable],dialog[open]')
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return void (dialog?.open ? dialog.close() : open()) }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e.target)) return
    if (e.key === '/') { e.preventDefault(); return void open() }
    if (e.key === 'Escape' && document.body.classList.contains('menu-open')) return void setMenu(false)
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const a = document.querySelector('.pager a.' + (e.key === 'ArrowLeft' ? 'prev' : 'next'))
    if (!a) return
    e.preventDefault()
    go(a.href, true)
  })

  window.addEventListener('resize', () => indicator(false))
  document.fonts?.ready.then(placeIndicator)
  placeIndicator()
  toc()
  syncLang(location.pathname)
  warmNeighbors()
})()

// ── 스크린샷 확대 보기 (클릭 → 라이트박스, Esc/배경 클릭으로 닫기) ──
;(() => {
  const strings = () => JSON.parse(document.getElementById('i18n')?.textContent || '{}')
  let box, last
  const close = () => { if (!box) return; box.remove(); box = null; document.body.style.overflow = ''; last?.focus() }
  document.addEventListener('click', (e) => {
    if (box && (e.target === box || e.target.closest?.('.lightbox-close'))) return close()
    const b = e.target.closest?.('[data-zoom]')
    if (!b) return
    last = b
    box = document.createElement('div')
    box.className = 'lightbox'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    const img = document.createElement('img')
    img.src = (document.documentElement.dataset.theme === 'light' && b.dataset.zoomLight) || b.dataset.zoom
    img.alt = b.querySelector('img')?.alt || ''
    const x = document.createElement('button')
    x.type = 'button'; x.className = 'lightbox-close'; x.textContent = '×'; x.setAttribute('aria-label', strings().zoomClose || 'Close')
    box.append(img, x)
    document.body.append(box)
    document.body.style.overflow = 'hidden'
    x.focus()
  })
  document.addEventListener('keydown', (e) => { if (box && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }, true)
})()
