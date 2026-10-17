// 랜딩 페이지의 체험 데모. 서버 없이 브라우저에서만 돌아가는 가짜 대화 화면이다(네트워크 요청 없음).
// 마크업·치수는 실제 앱(client/src/components: Sidebar, Header, Message, WorkBox, Composer, StatusLine)을 그대로 따른다.
// 시나리오·문구는 #demo-data(JSON)에서 읽는다 → site.js의 land.demo
;(() => {
  const root = document.getElementById('demo')
  const raw = document.getElementById('demo-data')
  if (!root || !raw) return
  const D = JSON.parse(raw.textContent)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const html = (node, h) => { node.innerHTML = h; return node }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  // client/src/components/Icon.svelte 의 경로 그대로
  const P = {
    sidebar: 'M4 5h16v14H4zM9.5 5v14', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5', plus: 'M12 5v14M5 12h14',
    down: 'M6 9l6 6 6-6', right: 'M9 6l6 6-6 6', file: 'M7 3h7l5 5v13H7zM14 3v5h5', folder: 'M3 6h6l2 2h10v11H3z',
    copy: 'M9 9h10v11H9zM5 15V4h10', reply: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4', fork: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    terminal: 'M4 5h16v14H4zM7 10l3 2.5L7 15M12 15h5', pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    check: 'M5 12.5l4.5 4.5L19 7.5', send: 'M12 19V5M5 12l7-7 7 7', more: 'M5 12h.01M12 12h.01M19 12h.01', brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    gauge: 'M4.5 18a8.5 8.5 0 1 1 15 0M12 14l4-5M12 14h.01', cache: 'M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5', coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.6 9.6c-.5-1-1.5-1.6-2.6-1.6-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2.1-.6-2.6-1.6M12 6.5V8M12 16v1.5',
    skill: 'M12 7c-1.6-1.4-3.7-2-7-2v13c3.3 0 5.4.6 7 2 1.6-1.4 3.7-2 7-2V5c-3.3 0-5.4.6-7 2zM12 7v13', list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  }
  const ic = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n]}"/></svg>`
  const TOOL_ICON = { ls: 'folder', read: 'file', write: 'pencil', edit: 'pencil', bash: 'terminal' }
  const toolIcon = (n) => TOOL_ICON[n] || 'terminal'

  // PipayaMark(color): 실제 앱의 사이드바 마크
  const MARK = '<svg class="mark" viewBox="15.22 11.44 97.56 97.56" role="img" aria-label="pipaya"><defs><mask id="dm-ki" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><rect x="-64" y="-64" width="256" height="256" fill="#fff"/><circle cx="55.5" cy="68" r="13.7" fill="#000"/><circle cx="72.5" cy="68" r="13.7" fill="#000"/></mask></defs><g mask="url(#dm-ki)"><path class="trunk" d="M51 62H77L86 106H42Z"/><g class="leaf"><ellipse cx="64" cy="58" rx="6.5" ry="8.5"/><path d="M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z" transform="translate(64 62) rotate(-100) scale(1.1 0.99)"/><path d="M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z" transform="translate(64 62) rotate(-50) scale(1.1 1.1)"/><path d="M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z" transform="translate(64 62) rotate(0) scale(1.1 1.034)"/><path d="M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z" transform="translate(64 62) rotate(50) scale(1.1 1.1)"/><path d="M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z" transform="translate(64 62) rotate(100) scale(1.1 0.99)"/></g></g><circle class="fruit" cx="55.5" cy="68" r="10.5"/><circle class="fruit" cx="72.5" cy="68" r="10.5"/></svg>'
  P.columns = 'M4 5h16v14H4zM12 5v14'
  root.textContent = ''
  const mobile = () => matchMedia('(max-width:760px)').matches
  // 실제 클라이언트(lib/motion.ts)의 토큰: fast 180 / normal 360, 진입 감속·퇴장 가속 곡선
  const T = { fast: reduce ? 0 : 180, normal: reduce ? 0 : 360 }
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const EASE_EXIT = 'cubic-bezier(0.3, 0, 0.8, 0.15)'

  const MONO = MARK.replace('class="mark"', 'class="mark mono"').replace(/dm-ki/g, 'dm-kj')
  const faceHtml = (state) => `<span class="agent ${state}">${MONO}${state !== 'idle' ? '<i class="badge"></i>' : ''}</span>`

  // ── 뼈대 ──
  const win = el('div', 'dm')
  const title = html(el('div', 'dm-title'), '<i></i><i></i><i></i>'); title.append(el('span', '', 'pipaya'))
  const body = el('div', 'dm-body')
  const side = el('aside', 'dm-side')
  const scrim = el('div', 'dm-scrim')
  const main = el('div', 'dm-main')
  const stage = el('div', 'dm-stage')
  const noticeBox = el('div', 'dm-notices'); noticeBox.setAttribute('aria-live', 'polite')
  const log = el('div', 'dm-log'); log.setAttribute('aria-live', 'polite')
  const gv = el('div', 'dm-group'); gv.hidden = true

  // ── 상태 ──
  const sessions = []          // 목록에 있는 대화 (최신이 앞)
  const groups = []            // {id, name, members: [session]}
  const folded = new Set()
  let seq = 0, gseq = 0
  let active = null            // 현재 열린 대화(초안 포함)
  let dragId = null
  let collapsed = false
  const mkSession = (t, dir, state) => {
    const s = { id: 's' + ++seq, title: t, dir, state, gid: null, flow: el('div', 'dm-flow') }
    return s
  }
  const mkDraft = () => {
    const d = mkSession(D.newChat, D.cwd, 'idle'); d.draft = true
    const hello = el('div', 'dm-empty'); hello.append(el('b', '', D.emptyTitle), el('span', '', D.emptyBody))
    d.flow.append(hello)
    return d
  }
  const groupOf = (s) => groups.find((g) => g.id === s.gid) || null
  const byId = (id) => sessions.find((s) => s.id === id)

  // ── 접기·펴기 (실제 collapseIn/collapseOut = svelte slide) ──
  function collapse(node, open) {
    node.getAnimations().forEach((a) => a.cancel())
    if (open) {
      node.hidden = false
      const h = node.scrollHeight
      if (!T.normal) return
      node.style.overflow = 'hidden'
      const a = node.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: T.normal, easing: EASE })
      a.onfinish = a.oncancel = () => { node.style.overflow = '' }
    } else {
      if (!T.fast) { node.hidden = true; return }
      node.style.overflow = 'hidden'
      const a = node.animate([{ height: node.scrollHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: T.fast, easing: EASE_EXIT })
      a.onfinish = () => { node.hidden = true; node.style.overflow = '' }
    }
  }
  function toggleFold(key, node, chev) {
    const open = folded.has(key)
    open ? folded.delete(key) : folded.add(key)
    chev.classList.toggle('folded', !open)
    collapse(node, open)
    trackInd()
  }

  // ── 슬라이딩 선택 마커 (실제 lib/sliding-indicator.ts: 360ms ease로 이동) ──
  const inds = []
  function makeInd(container, selector, variant) {
    const ind = el('span', 'dm-ind'); ind.dataset.variant = variant || ''; ind.style.display = 'none'
    container.prepend(ind)
    const o = { container, ind, selector, ready: false }
    inds.push(o); return o
  }
  function placeInd(o) {
    const t = o.container.querySelector(o.selector)
    if (!t || !o.container.offsetParent) { o.ind.style.display = 'none'; o.ready = false; o.container.classList.remove('ind-ready'); return }
    const cr = o.container.getBoundingClientRect(), r = t.getBoundingClientRect()
    const x = r.left - cr.left + o.container.scrollLeft, y = r.top - cr.top + o.container.scrollTop
    const first = !o.ready
    if (first) o.ind.style.transition = 'none'
    o.ind.style.display = 'block'
    o.ind.style.width = r.width + 'px'; o.ind.style.height = r.height + 'px'
    o.ind.style.transform = `translate(${x}px,${y}px)`
    if (first) { o.ind.offsetWidth; o.ind.style.transition = ''; o.ready = true; o.container.classList.add('ind-ready') }
  }
  let tracking = 0
  function trackInd(ms = 520) {
    const end = performance.now() + ms
    if (tracking) { tracking = Math.max(tracking, end); return } // 짧은 호출(ResizeObserver의 60ms)이 긴 추적(접기 480ms)을 끊지 않게 늦은 쪽을 유지
    tracking = end
    const step = () => { inds.forEach(placeInd); if (performance.now() < tracking) requestAnimationFrame(step); else tracking = 0 }
    requestAnimationFrame(step)
  }

  // ── 사이드바 (실제 Sidebar.svelte) ──
  const full = el('div', 'dm-full')
  html(full, `<div class="dm-brand">${MARK}<span class="wm">pipaya</span><button type="button" class="dm-fold" aria-label="${D.fold}">${ic('sidebar')}</button></div>
<div class="dm-tools"><div class="dm-search">${ic('search')}<span>${D.search}</span></div><button type="button" class="dm-new" aria-label="${D.newChat}">${ic('plus')}</button></div>`)
  const list = el('nav', 'dm-list')
  const tree = el('div', 'dm-tree')
  const listInd = makeInd(list, '.dm-item.active', '')
  list.append(tree); full.append(list)
  html(full.appendChild(el('div', 'dm-bottom')), `<span class="dm-set">${ic('settings')} ${D.settings}</span>`)

  // 접힌 사이드바 = 좁은 레일 (실제 Rail.svelte)
  const rail = el('div', 'dm-rail')
  html(rail, `<div class="top">${MARK.replace(/dm-ki/g, 'dm-kr')}</div>
<div class="tools"><button type="button" class="btn-ico r-expand" aria-label="${D.expand}" title="${D.expand}">${ic('sidebar')}</button><button type="button" class="btn-ico r-new" aria-label="${D.newChat}" title="${D.newChat}">${ic('plus')}</button></div>`)
  const agents = el('ul', 'agents')
  const railInd = makeInd(agents, '.agent-btn.active', 'ring')
  rail.append(agents)
  html(rail.appendChild(el('div', 'bottom')), `<button type="button" class="btn-ico" aria-label="${D.settings}" title="${D.settings}">${ic('settings')}</button>`)
  side.append(full, rail)

  // ── 그룹: 끌어서 합치기 / 빼기 ──
  function removeFromGroup(s) {
    const g = groupOf(s); if (!g) return
    g.members = g.members.filter((m) => m !== s); s.gid = null
    if (g.members.length < 2) { g.members.forEach((m) => { m.gid = null }); groups.splice(groups.indexOf(g), 1) }
  }
  function addToGroup(s, g) { if (s.gid === g.id) return; removeFromGroup(s); g.members.push(s); s.gid = g.id }
  function groupWith(a, b) {
    if (a === b || (a.gid && a.gid === b.gid)) return
    const g = groupOf(b)
    if (g) addToGroup(a, g)
    else {
      removeFromGroup(a)
      const ng = { id: 'g' + ++gseq, name: D.groupName + ' ' + gseq, members: [] }
      groups.push(ng); b.gid = ng.id; a.gid = ng.id; ng.members.push(b, a)
    }
    active = b
    renderAll()
  }
  function leaveGroup(s) { if (!s.gid) return; removeFromGroup(s); renderAll() }
  const dnd = (node, onDrop, accepts = () => true) => {
    node.addEventListener('dragover', (e) => { if (dragId && accepts()) { e.preventDefault(); node.classList.add('over') } })
    node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('over') })
    node.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.remove('over'); const s = byId(dragId); dragId = null; if (s) onDrop(s) })
  }
  const dragSrc = (node, s) => {
    node.draggable = true
    node.addEventListener('dragstart', (e) => { dragId = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); node.classList.add('carried') })
    node.addEventListener('dragend', () => { dragId = null; node.classList.remove('carried') })
  }

  function row(s) {
    const b = el('div', 'dm-item' + (s === active ? ' active' : '')); b.dataset.sid = s.id
    const open = el('button', 'open'); open.type = 'button'
    html(open, `${faceHtml(s.state)}<span class="title"></span>`)
    open.querySelector('.title').textContent = s.title
    open.onclick = () => openSession(s)
    b.append(open); dragSrc(b, s)
    dnd(b, (a) => groupWith(a, s), () => dragId !== s.id)
    return b
  }
  function renderSide() {
    tree.textContent = ''
    const srv = el('section', 'dm-srv')
    const head = el('div', 'srvhead')
    const stog = el('button', 'srvtoggle'); stog.type = 'button'
    html(stog, `<span class="chev ${folded.has('srv') ? 'folded' : ''}">${ic('down')}</span><span class="sdot"></span><span class="sname">${D.server}</span><span class="dcount">${sessions.length}</span>`)
    head.append(stog); srv.append(head)
    const sfold = el('div', 'fold'); sfold.hidden = folded.has('srv'); srv.append(sfold)
    stog.onclick = () => toggleFold('srv', sfold, stog.querySelector('.chev'))
    const dirs = [...new Set(sessions.filter((s) => !s.gid).map((s) => s.dir))]
    dirs.forEach((d) => {
      const items = sessions.filter((s) => !s.gid && s.dir === d)
      const blk = el('div', 'dm-dirblock')
      const dh = el('div', 'dir'); const dt = el('button', 'dirtoggle'); dt.type = 'button'
      html(dt, `<span class="chev ${folded.has('d:' + d) ? 'folded' : ''}">${ic('down')}</span><span class="dname"></span><span class="dcount">${items.length}</span>`)
      dt.querySelector('.dname').textContent = d
      dh.append(dt); blk.append(dh)
      const f = el('div', 'fold'); f.hidden = folded.has('d:' + d); items.forEach((s) => f.append(row(s))); blk.append(f)
      dt.onclick = () => toggleFold('d:' + d, f, dt.querySelector('.chev'))
      dnd(dh, leaveGroup, () => !!byId(dragId)?.gid)
      sfold.append(blk)
    })
    groups.forEach((g) => {
      const blk = el('div', 'dm-dirblock grp')
      const gh = el('div', 'grphead' + (groupOf(active) === g ? ' cur' : '')); const gt = el('button', 'grptoggle'); gt.type = 'button'
      html(gt, `<span class="chev ${folded.has(g.id) ? 'folded' : ''}">${ic('down')}</span><span class="gicon">${ic('columns')}</span><span class="dname"></span><span class="dcount">${g.members.length}</span>`)
      gt.querySelector('.dname').textContent = g.name
      gh.append(gt); blk.append(gh)
      const f = el('div', 'fold'); f.hidden = folded.has(g.id); g.members.forEach((s) => f.append(row(s))); blk.append(f)
      gt.onclick = () => toggleFold(g.id, f, gt.querySelector('.chev'))
      dnd(blk, (s) => { addToGroup(s, g); active = s; renderAll() }, () => !!byId(dragId) && byId(dragId).gid !== g.id)
      sfold.append(blk)
    })
    tree.append(srv)
    dnd(list, leaveGroup, () => !!byId(dragId)?.gid)
  }
  function agentBtn(s) {
    const li = el('li'); const b = el('button', 'agent-btn' + (s === active ? ' active' : '')); b.type = 'button'; b.dataset.sid = s.id
    html(b, faceHtml(s.state)); b.title = s.title; b.setAttribute('aria-label', s.title)
    b.onclick = () => openSession(s); dragSrc(b, s)
    dnd(b, (a) => groupWith(a, s), () => dragId !== s.id)
    li.append(b); return li
  }
  function renderRail() {
    agents.querySelectorAll(':scope > :not(.dm-ind)').forEach((n) => n.remove())
    const dirs = [...new Set(sessions.filter((s) => !s.gid).map((s) => s.dir))]
    dirs.forEach((d, i) => {
      if (i) agents.append(el('li', 'sep'))
      sessions.filter((s) => !s.gid && s.dir === d).forEach((s) => agents.append(agentBtn(s)))
    })
    groups.forEach((g, i) => {
      if (i || dirs.length) agents.append(el('li', 'sep'))
      const li = el('li', 'folder' + (groupOf(active) === g ? ' cur' : '')); li.title = g.name
      const ul = el('ul', 'members'); g.members.forEach((s) => ul.append(agentBtn(s))); li.append(ul)
      dnd(li, (s) => { addToGroup(s, g); active = s; renderAll() }, () => !!byId(dragId) && byId(dragId).gid !== g.id)
      agents.append(li)
    })
    dnd(agents, leaveGroup, () => !!byId(dragId)?.gid)
  }
  function paintState(s) {
    strip.querySelectorAll('.schip').forEach((c, i) => { const g = groupOf(active); if (g && g.members[i] === s) c.querySelector('.bdg, .agent')?.replaceWith(html(el('span'), faceHtml(s.state)).firstChild) })
    const cell = cells.get(s.id)
    if (cell) { cell.querySelector('.cellhead .bdg').innerHTML = faceHtml(s.state); cell.classList.toggle('finished', s.state === 'done' && s !== active) }
    side.querySelectorAll(`[data-sid="${s.id}"] .agent`).forEach((a) => {
      a.className = 'agent ' + s.state
      const bd = a.querySelector('.badge')
      if (s.state === 'idle') { if (bd) bd.remove() } else if (!bd) a.append(el('i', 'badge'))
    })
  }

  // ── 본문: 단일 대화 / 그룹(분할) ──
  const cells = new Map()
  function layout(n) {
    if (mobile()) return Array.from({ length: n }, (_, i) => [0, (i * 100) / n, 100, 100 / n])   // 모바일은 위아래로 쌓는다
    if (n === 1) return [[0, 0, 100, 100]]
    if (n === 2) return [[0, 0, 50, 100], [50, 0, 50, 100]]
    if (n === 3) return [[0, 0, 50, 100], [50, 0, 50, 50], [50, 50, 50, 50]]
    const r = []; for (let i = 0; i < n; i++) r.push([(i % 2) * 50, Math.floor(i / 2) * (100 / Math.ceil(n / 2)), 50, 100 / Math.ceil(n / 2)]); return r
  }
  // 실제 SessionStrip.svelte: 폰에서 열린 그룹의 대화들을 헤더 아래 칩으로. 눌러서 전환
  const strip = el('nav', 'dm-strip'); strip.hidden = true
  function renderStrip() {
    const g = mobile() ? groupOf(active) : null
    strip.hidden = !g; strip.textContent = ''
    if (!g) return
    strip.append(el('span', 'sname', g.name))
    g.members.forEach((m) => {
      const b = el('button', 'schip' + (m === active ? ' on' : '')); b.type = 'button'
      html(b, `${faceHtml(m.state)}<span class="st"></span>`); b.querySelector('.st').textContent = m.title
      b.onclick = () => openSession(m)
      strip.append(b)
    })
    const on = strip.querySelector('.on'); if (on) requestAnimationFrame(() => on.scrollIntoView({ inline: 'center', block: 'nearest' }))
  }
  function renderMain() {
    const g = mobile() ? null : groupOf(active)      // 실제 클라이언트: 좁은 화면은 분할 없이 한 대화 + 세션 스트립
    renderStrip()
    const hs = head.querySelector('.t'), sub = head.querySelector('.sub')
    if (g) {
      log.hidden = true; gv.hidden = false
      const rects = layout(g.members.length)
      const had = gv.classList.contains('shown')
      g.members.forEach((s, i) => {
        let c = cells.get(s.id)
        if (!c) {
          c = el('div', 'dm-cell'); const pane = el('section', 'dm-pane')
          const ch = el('header', 'cellhead'); const cb = el('div', 'cellbody')
          html(ch, `<span class="bdg"></span><span class="tt"><span class="t"></span><span class="cwd mono"></span></span><button type="button" class="x" tabindex="-1" aria-hidden="true">${ic('expand')}</button><button type="button" class="x leave" aria-label="${D.leave}" title="${D.leave}">${ic('unlink')}</button>`)
          const ci = el('div', 'dm-cellbox'); html(ci, `<span class="ph">${D.placeholder.split(' · ')[0]}</span><span class="row2"><span class="ib">${ic('file')}</span><span class="mname">${D.model}</span><span class="grow"></span><span class="snd">${ic('send')}</span></span>`)
          pane.append(ch, cb, ci); c.append(pane); cells.set(s.id, c); gv.append(c)
          pane.addEventListener('pointerdown', () => { if (active !== s) openSession(s) })
          ch.querySelector('.leave').onclick = (e) => { e.stopPropagation(); leaveGroup(s) }
          c.style.left = rects[i][0] + '%'; c.style.top = rects[i][1] + '%'; c.style.width = rects[i][2] + '%'; c.style.height = rects[i][3] + '%'
        }
        c.querySelector('.cellhead .t').textContent = s.title
        c.querySelector('.cellhead .cwd').textContent = s.dir.split('/').slice(-2).join('/')
        c.querySelector('.cellhead .bdg').innerHTML = faceHtml(s.state)
        c.classList.toggle('focus', s === active)
        c.classList.toggle('finished', s.state === 'done' && s !== active)
        if (s.flow.parentElement !== c.querySelector('.cellbody')) c.querySelector('.cellbody').append(s.flow)
        const r = rects[i]
        c.style.left = r[0] + '%'; c.style.top = r[1] + '%'; c.style.width = r[2] + '%'; c.style.height = r[3] + '%'
        const sc = s.flow.parentElement; sc.scrollTop = sc.scrollHeight
      })
      cells.forEach((c, id) => { if (!g.members.some((m) => m.id === id)) { c.remove(); cells.delete(id) } })
      requestAnimationFrame(() => gv.classList.add('shown'))
      head.classList.add('group'); hs.textContent = g.name; sub.textContent = D.chatsN.replace('{n}', g.members.length)
    } else {
      head.classList.remove('group'); gv.hidden = true; gv.classList.remove('shown'); cells.forEach((c) => c.remove()); cells.clear()
      log.hidden = false
      if (log.firstChild !== active.flow) log.replaceChildren(active.flow)
      log.scrollTop = log.scrollHeight
      hs.textContent = active.title; sub.textContent = active.dir.split('/').slice(-2).join('/')
    }
    // 실제와 같이 그룹에서는 칸마다 입력창이 있다: 포커스된 칸에 진짜 입력창·상태줄을, 나머지는 모양만 둔다
    cells.forEach((c, id) => {
      const mine = g && id === active.id
      c.querySelector('.dm-cellbox').hidden = !!mine
      const pane = c.firstChild
      if (mine) pane.append(chips, composer, stats)
    })
    if (!g && composer.parentElement !== main) main.append(chips, composer, stats)
  }
  function renderAll() { renderSide(); renderRail(); renderMain(); trackInd(); lockUi() }
  function openSession(s) {
    clearNoticeOf(s)
    if (s === active) { if (mobile()) win.classList.remove('drawer'); return }
    active = s
    renderSide(); renderRail(); renderMain(); trackInd(); lockUi()
    if (mobile()) win.classList.remove('drawer')
  }
  function newChat() {
    if (active.draft) return
    const d = mkDraft(); active = d; renderAll()
    if (mobile()) win.classList.remove('drawer')
  }

  // ── 사이드바 접기/펴기 (실제: width 360ms, 접히면 레일) ──
  function setSide(open) {
    if (mobile()) { win.classList.toggle('drawer', open); return }
    collapsed = !open
    side.classList.toggle('collapsed', collapsed)
    trackInd(480)
  }
  full.querySelector('.dm-fold').onclick = () => (mobile() ? setSide(false) : setSide(false))
  rail.querySelector('.r-expand').onclick = () => setSide(true)
  full.querySelector('.dm-new').onclick = newChat
  rail.querySelector('.r-new').onclick = newChat
  scrim.onclick = () => win.classList.remove('drawer')

  // ── 헤더 ──
  const head = el('header', 'dm-head')
  html(head, `<div class="capsule"><button type="button" class="menu" aria-label="${D.fold}">${ic('sidebar')}</button><div class="ttl"><span class="t"></span><span class="sub mono"></span></div></div>`)
  head.querySelector('.menu').onclick = () => setSide(true)

  // ── 완료 알림 (실제 DoneNotice.svelte): 헤더 아래 stage 맨 위. 보고 있지 않은 대화가 끝났을 때만, 누르면 그 대화로 ──
  P.x = 'M6 6l12 12M18 6L6 18'
  const NOTICE_MS = 6000
  function notice(S, failed) {
    if (S === active) return
    if (!mobile() && !groupOf(active)) return      // 실제 App.svelte: 알림 띠는 좁은 화면이거나 그룹이 열려 있을 때만
    const r = el('div', 'dm-notice' + (failed ? ' failed' : ''))
    r.setAttribute('role', failed ? 'alert' : 'status')
    const go = el('button', 'go'); go.type = 'button'
    html(go, `<span class="agent done">${MONO.replace(/dm-kj/g, 'dm-kn' + S.id)}</span><span class="title"></span><span class="verdict">${failed ? D.failed : D.done}</span>`)
    go.querySelector('.title').textContent = S.title
    const x = el('button', 'cclose'); x.type = 'button'; x.setAttribute('aria-label', D.close)
    html(x, `<svg class="ring" viewBox="0 0 28 28" aria-hidden="true"><circle class="track" cx="14" cy="14" r="12"/><circle class="left" cx="14" cy="14" r="12" pathLength="100" style="animation-duration:${NOTICE_MS}ms"/></svg>${ic('x')}`)
    r.append(go, x); r.sid = S.id
    const kill = () => {
      clearTimeout(r.timer)
      if (!r.isConnected) return
      const a = r.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4.5px)' }], { duration: T.fast, easing: EASE_EXIT })
      a.onfinish = () => r.remove()
    }
    r.kill = kill
    go.onclick = () => { kill(); openSession(S) }
    x.onclick = kill
    noticeBox.prepend(r)
    r.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: T.normal, easing: EASE })
    r.timer = setTimeout(kill, NOTICE_MS)
  }
  // 보고 있는 대화의 알림은 바로 치운다 (실제 DoneNotice의 $effect)
  const clearNoticeOf = (S) => noticeBox.querySelectorAll('.dm-notice').forEach((n) => { if (n.sid === S.id) n.kill() })

  const scroll = (S) => { const p = S.flow.parentElement; if (p) p.scrollTop = p.scrollHeight }
  async function typeInto(S, node, text) {
    if (reduce) { node.textContent = text; scroll(S); return }
    for (let i = 0; i < text.length; i += 3) { node.textContent = text.slice(0, i + 3); scroll(S); await sleep(16) }
    node.textContent = text
  }
  const userRow = (S, text, fresh = true) => { const r = el('div', 'dm-row dm-userrow' + (fresh ? ' fresh' : '')); r.append(el('div', 'dm-user', text)); S.flow.append(r); scroll(S); return r }
  const aiRow = (S, fresh = true) => { const r = el('div', 'dm-row dm-airow' + (fresh ? ' fresh' : '')); S.flow.append(r); return r }
  const aiText = (r) => { const p = el('div', 'dm-ai'); r.append(p); return p }
  const foot = () => html(el('div', 'dm-foot'), `<span class="ib">${ic('copy')}</span><span class="ib">${ic('reply')}</span><span class="ib">${ic('fork')}</span><span class="stats">${D.meta}</span>`)

  // 지난 대화: 내용이 있어서 눌러 보면 바로 바뀐다
  ;(D.past || []).slice().reverse().forEach(([dir, t]) => {
    const s = mkSession(t, dir, 'idle')
    userRow(s, t, false)
    const r = aiRow(s, false); aiText(r).textContent = D.pastReply; r.append(foot())
    sessions.push(s)
  })

  // 실행 상태는 대화마다 따로: 돌아가는 동안 다른 대화로 옮겨 다닐 수 있다
  const isBusy = () => !!active.busy
  function lockUi() { const b = isBusy(); input.disabled = b; chips.classList.toggle('off', b); sync() }
  function lockS(S, v) { S.busy = v; lockUi() }
  const setState = (S, st) => { S.state = st; paintState(S) }

  function workBox(t) {
    const g = el('div', 'dm-work')
    const box = el('button', 'dm-wbox'); box.type = 'button'
    html(box, `<span class="ico">${ic(toolIcon(t.name))}</span><span class="roll"><span class="line"><b class="name">${t.name}</b><span class="sum mono"></span></span></span><span class="meta"><span class="spin"></span><span class="chip">…</span><span class="open">${ic('right')}</span></span>`)
    box.querySelector('.sum').textContent = t.arg
    g.append(box)
    const st = box.querySelector('.chip'), spin = box.querySelector('.spin')
    let out = null, isOpen = false
    const setOut = (text) => { if (out) out.remove(); out = el('pre', 'dm-out mono', text); g.append(out); out.hidden = !isOpen }
    box.addEventListener('click', () => { isOpen = !isOpen; g.classList.toggle('open', isOpen); if (out) out.hidden = !isOpen })
    return { g, box, st, spin, setOut }
  }

  async function run(prompt) {
    if (isBusy() || !prompt.trim()) return
    menu.hidden = true
    const S = active
    lockS(S, true)
    if (S.draft) {
      delete S.draft; S.title = prompt.slice(0, 24); S.state = 'working'
      S.flow.querySelector('.dm-empty')?.remove()
      sessions.unshift(S); renderAll()
    } else { S.state = 'working'; paintState(S) }
    userRow(S, prompt)
    await sleep(350)
    const text = prompt.toLowerCase()
    const sc = D.scenarios.find((s) => s.keys.some((k) => text.includes(k.toLowerCase())))
    const r = aiRow(S)
    if (!sc) {
      await typeInto(S, aiText(r), D.fallback)
      setState(S, 'idle')
      return lockS(S, false)
    }
    await typeInto(S, aiText(r), sc.intro)
    const w = workBox(sc.tool)
    r.append(w.g); scroll(S)
    if (sc.approval) {
      w.st.textContent = D.needs; w.st.className = 'chip warn'; w.spin.hidden = true
      w.g.classList.add('warn'); setState(S, 'asking')
      const ask = el('div', 'dm-approve')
      html(ask, `<span class="ask">${ic('shield')} ${D.runIt}</span>`)
      const deny = el('button', 'dm-btn', D.deny); deny.type = 'button'
      const ok = html(el('button', 'dm-btn primary'), ic('check')); ok.append(' ' + D.approve); ok.type = 'button'
      ask.append(deny, ok); w.g.append(ask); scroll(S)
      const approved = await new Promise((res) => { ok.onclick = () => res(true); deny.onclick = () => res(false) })
      ask.remove(); w.g.classList.remove('warn'); setState(S, 'working'); w.spin.hidden = false
      if (!approved) {
        setState(S, 'idle'); w.spin.hidden = true
        w.st.textContent = D.denied; w.st.className = 'chip danger'
        await typeInto(S, aiText(r), sc.denied)
        r.append(foot()); scroll(S)
        return lockS(S, false)
      }
    }
    w.st.textContent = D.running; w.st.className = 'chip accent'
    await sleep(reduce ? 0 : 650)
    w.spin.hidden = true
    w.st.textContent = D.done; w.st.className = 'chip ok'
    if (sc.result) { w.setOut(sc.result); scroll(S) }
    await sleep(250)
    await typeInto(S, aiText(r), sc.final)
    r.append(foot()); scroll(S)
    setState(S, 'done')
    notice(S, false)
    lockS(S, false)
  }

  // ── 예시 칩 ──
  const chips = el('div', 'dm-chips')
  D.scenarios.forEach((s) => {
    const b = el('button', 'dm-chip', s.label); b.type = 'button'
    b.onclick = () => run(s.prompt)
    chips.append(b)
  })

  // ── 컴포저 ──
  const composer = el('form', 'dm-composer')
  const menu = el('div', 'dm-menu'); menu.hidden = true
  const box = el('div', 'dm-box')
  const input = el('input', 'dm-input')
  input.placeholder = D.placeholder; input.setAttribute('aria-label', D.placeholder); input.autocomplete = 'off'; input.spellcheck = false
  const sendBtn = el('button', 'dm-send'); sendBtn.type = 'submit'; sendBtn.setAttribute('aria-label', D.send); sendBtn.innerHTML = ic('send')
  const bar = el('div', 'dm-bar')
  html(bar, `<span class="ib" aria-hidden="true">${ic('file')}</span><span class="dm-model"><span class="mname">${D.model}</span><span class="chip think">${D.level}</span><span class="chev">${ic('down')}</span></span><span class="grow"></span>`)
  bar.append(sendBtn)
  box.append(menu, input, bar)
  composer.append(box)
  const stats = html(el('div', 'dm-status mono'), `<span class="b">${ic('skill')}<span class="v">${D.skills}</span></span><span class="b"><svg class="ring" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" class="track"/><circle cx="9" cy="9" r="7" class="fill" stroke-dasharray="44" stroke-dashoffset="38"/></svg><span class="v">6%</span></span><span class="b">${ic('cache')}<span class="v">84%</span></span>`)
  function sync() { const b = isBusy(); sendBtn.classList.toggle('on', !b && input.value.trim().length > 0); sendBtn.disabled = b || !input.value.trim() }

  stage.append(noticeBox, log, gv)
  main.append(head, strip, stage, chips, composer, stats)
  body.append(side, main, scrim)
  win.append(title, body)
  root.append(win)

  function renderMenu() {
    const v = input.value
    if (!v.startsWith('/')) { menu.hidden = true; return }
    const q = v.slice(1).toLowerCase()
    const items = D.slash.filter(([c]) => c.slice(1).toLowerCase().startsWith(q))
    menu.textContent = ''
    if (!items.length) { menu.hidden = true; return }
    items.forEach(([c, d]) => {
      const r = el('button', 'dm-item2'); r.type = 'button'
      r.append(el('b', '', c), el('span', '', d))
      r.onmousedown = (e) => { e.preventDefault(); input.value = c + ' '; menu.hidden = true; input.focus(); sync() }
      menu.append(r)
    })
    menu.hidden = false
  }
  input.addEventListener('input', () => { renderMenu(); sync() })
  composer.addEventListener('submit', (e) => {
    e.preventDefault()
    const v = input.value.trim()
    if (!v) return
    input.value = ''; sync()
    if (v.startsWith('/')) { menu.hidden = true; return void bubbleSlash(v) }
    run(v)
  })
  function bubbleSlash(v) {
    if (v.startsWith('/new')) return newChat()
    const S = active
    S.flow.querySelector('.dm-empty')?.remove()
    userRow(S, v)
    const hit = D.slash.find(([c]) => v.startsWith(c))
    const r = aiRow(S); const p = aiText(r); p.classList.add('dm-sys'); p.textContent = hit ? hit[1] : D.fallback; scroll(S)
  }

  active = mkDraft()
  renderAll()
  new ResizeObserver(() => trackInd(60)).observe(list)
  matchMedia('(max-width:760px)').addEventListener('change', () => { win.classList.remove('drawer'); renderMain(); trackInd() })
  sync()

  // ── 자동 시연: 처음 보이면 스스로 대화를 열고, 창을 분할해 실제 클라이언트처럼 보여 준다. 사용자가 만지면 즉시 멈춘다 ──
  let taken = false
  const take = () => { taken = true }
  root.addEventListener('pointerdown', take, { once: true })
  root.addEventListener('keydown', take, { once: true })
  const wait = async (ms) => { await sleep(reduce ? Math.min(ms, 60) : ms); return !taken }
  async function say(text) {
    for (let i = 1; i <= text.length; i++) {
      if (taken) { input.value = ''; sync(); return false }
      input.value = text.slice(0, i); sync()
      await sleep(reduce ? 0 : 32)
    }
    await sleep(reduce ? 0 : 260)
    if (taken) { input.value = ''; sync(); return false }
    composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    return true
  }
  async function autoplay() {
    const [a, b, c] = D.scenarios
    if (!(await wait(700)) || !(await say(a.prompt))) return
    const s1 = active
    if (!(await wait(1000))) return
    newChat()
    if (!(await wait(350)) || !(await say(b.prompt))) return
    const s2 = active
    if (!(await wait(900))) return
    groupWith(s2, s1)                       // 두 대화를 한 화면으로 합친다 (끌어놓기와 같은 동작)
    if (mobile()) {                         // 모바일: 스트립으로 대화를 오가고, 사이드바도 잠깐 보여 준다
      if (!(await wait(1500))) return
      openSession(s2)                       // 스트립의 칩을 눌러 다른 대화로 넘어가는 모습
      if (!(await wait(1800))) return
      openSession(s1)
      if (!(await wait(1500))) return
      setSide(true)
      if (!(await wait(2200))) return
      win.classList.remove('drawer')
      return
    }
    if (!(await wait(1600))) return
    newChat()
    if (!(await wait(350)) || !(await say(c.prompt))) return
    const s3 = active
    addToGroup(s3, groupOf(s1)); active = s1; renderAll()    // 세 번째 대화도 분할 화면에 합류. 승인 카드는 눌러 볼 수 있게 남겨 둔다
  }
  new IntersectionObserver((es, o) => {
    if (es.some((e) => e.isIntersecting)) { o.disconnect(); autoplay() }
  }, { threshold: 0.35 }).observe(root)
})()
