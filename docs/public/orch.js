// 랜딩 "에이전트끼리 일을 주고받습니다" 섹션: 두 세션 창과 가로 점선 연결선, 실시간으로 쳐지는 대화 데모.
// 창 마크업·CSS는 client의 Pane/Message/WorkBox/Composer를 그대로 옮긴 것이다 (docs/style.css의 .or-*).
// 색은 라이트/다크 테마(html[data-theme])를 CSS 변수로 따른다. 문구는 #demo-data(JSON)의 orch에서 읽는다. 네트워크 요청 없음.
;(() => {
  const root = document.getElementById('orch')
  const raw = document.getElementById('demo-data')
  if (!root || !raw) return
  const O = JSON.parse(raw.textContent).orch
  if (!O) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const NS = 'http://www.w3.org/2000/svg'
  const SPEED = 1.8 // 클수록 빠르다
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms / SPEED))

  root.textContent = ''
  // client Icon.svelte 의 path 와 같다
  const ICON = {
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
    file: 'M7 3h7l5 5v13H7zM14 3v5h5',
    send: 'M12 19V5M5 12l7-7 7 7',
    right: 'M9 6l6 6-6 6',
    down: 'M6 9l6 6 6-6',
    expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    unlink: 'M9 7H7a4 4 0 0 0 0 8h2M15 7h2a4 4 0 0 1 0 8h-2M4 4l16 16',
  }
  const icon = (n, size) => `<svg viewBox="0 0 24 24"${size ? ` width="${size}" height="${size}"` : ''} aria-hidden="true"><path d="${ICON[n]}"/></svg>`
  // client brand-marks.ts 의 claude 마크 (currentColor)
  const CLAUDE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>'
  // client PipayaMark.svelte (빈 대화 배경)
  const MARK = (() => {
    const leaf = 'M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z'
    const fronds = [[-100, .9], [-50, 1], [0, .94], [50, 1], [100, .9]].map(([a, k]) => `<path d="${leaf}" transform="translate(64 62) rotate(${a}) scale(1.1 ${1.1 * k})"/>`).join('')
    return `<svg viewBox="15.22 11.44 97.56 97.56" width="72" height="72" fill="currentColor" aria-hidden="true"><defs><mask id="or-pm" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><rect x="-64" y="-64" width="256" height="256" fill="#fff"/><circle cx="55.5" cy="68" r="13.7"/><circle cx="72.5" cy="68" r="13.7"/></mask></defs><g mask="url(#or-pm)"><path d="M51 62H77L86 106H42Z"/><ellipse cx="64" cy="58" rx="6.5" ry="8.5"/>${fronds}</g><circle cx="55.5" cy="68" r="10.5"/><circle cx="72.5" cy="68" r="10.5"/></svg>`
  })()

  const pane = (cls, name, title) => {
    const p = el('div', 'or-pane empty ' + cls)
    const badge = el('span', 'or-badge'); badge.innerHTML = CLAUDE + '<i></i>'
    const who = el('span', 'or-who', '@' + name)
    const tt = el('span', 'or-tt'); const t = el('span', 'or-t'); t.append(who, title)
    tt.append(t, el('span', 'or-cwd', 'workspace/pipaya-wiki'))
    const head = el('header', 'or-head'); head.append(badge, tt)
    for (const n of ['expand', 'unlink']) { const x = el('span', 'or-ib'); x.style.cssText = 'width:24px;height:24px'; x.innerHTML = icon(n); x.querySelector('svg').style.cssText = 'width:14px;height:14px'; x.style.color = 'var(--text-faint)'; head.append(x) }
    const bdy = el('div', 'or-bdy')
    const bg = el('div', 'or-bg'), hello = el('div', 'or-hello'); hello.innerHTML = MARK
    const body = el('div', 'or-body')
    bdy.append(bg, hello, body)
    const inp = el('div', 'or-in'); inp.dataset.ph = O.ph || ''
    const attach = el('span', 'or-ib'); attach.innerHTML = icon('file')
    const model = el('span', 'or-model'); model.append(el('span', null, 'Claude Sonnet 5.5'), el('span', 'or-eff', 'medium')); model.insertAdjacentHTML('beforeend', icon('down'))
    const send = el('span', 'or-send'); send.innerHTML = icon('send')
    const bar = el('div', 'or-bar'); bar.append(attach, model, el('span', 'or-grow'), send)
    const cbox = el('div', 'or-cbox'); cbox.append(inp, bar)
    const comp = el('div', 'or-comp'); comp.append(cbox)
    p.append(head, bdy, comp)
    return { p, badge, who, body, inp, send }
  }
  const A = pane('or-a', O.a, O.aTitle), B = pane('or-b', O.b, O.bTitle)
  const or = el('div', 'or')
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'or-wire'); svg.setAttribute('aria-hidden', 'true')
  const mk = (cls) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); svg.append(p); return p }
  const lineF = mk('or-line or-line--fwd'), lineB = mk('or-line or-line--back')
  const mkPort = (cls) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '4.5'); c.setAttribute('class', 'or-port ' + cls); svg.append(c); return c }
  const portsF = [mkPort('or-port--fwd'), mkPort('or-port--fwd')], portsB = [mkPort('or-port--back'), mkPort('or-port--back')]
  const mkPkt = (cls) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '5'); c.setAttribute('class', cls); svg.append(c); return c }
  const pktF = mkPkt('or-pkt'), pktB = mkPkt('or-pkt or-pkt--back')
  or.append(A.p, B.p, svg)
  const win = el('div', 'or-win')
  const bar0 = el('div', 'or-titlebar'); bar0.append(el('i'), el('i'), el('i'))
  win.append(bar0, or)
  const barR = el('div', 'or-bar-replay')
  const replay = el('button', 'ui-button ui-button--outline ui-button-size--default', O.replay)
  replay.type = 'button'; replay.hidden = true
  barR.append(replay)
  root.append(win, barR)

  // 연결선: 두 창 사이를 가로 직선 두 개로 잇는다. 위(가는 길)는 철수의 peer_send 카드 높이, 아래(오는 길)는 그 아래 줄
  const anchor = {}
  const mid = (n) => { if (!n) return null; const r = or.getBoundingClientRect(), q = n.getBoundingClientRect(); return q.top + q.height / 2 - r.top }
  const layout = () => {
    const r = or.getBoundingClientRect(), a = A.p.getBoundingClientRect(), b = B.p.getBoundingClientRect()
    const vertical = b.top - a.bottom > 20 && Math.abs(b.left - a.left) < 40
    let pf, pb
    if (vertical) {
      const cx = (a.left + a.width / 2) - r.left, y1 = a.bottom - r.top, y2 = b.top - r.top
      pf = [cx - 16, y1, cx - 16, y2]; pb = [cx + 16, y2, cx + 16, y1]
    } else {
      const x1 = a.right - r.left, x2 = b.left - r.left, h = r.height
      const clamp = (y) => Math.max(90, Math.min(h - 170, y))
      const yf = clamp(mid(anchor.f) ?? h * .42)
      const yb = clamp(Math.max(mid(anchor.b) ?? h * .62, yf + 56))
      pf = [x1, yf, x2, yf]; pb = [x2, yb, x1, yb]
    }
    lineF.setAttribute('d', `M${pf[0]} ${pf[1]}L${pf[2]} ${pf[3]}`); lineB.setAttribute('d', `M${pb[0]} ${pb[1]}L${pb[2]} ${pb[3]}`)
    const put = (c, x, y) => { c.setAttribute('cx', x); c.setAttribute('cy', y) }
    put(portsF[0], pf[0], pf[1]); put(portsF[1], pf[2], pf[3]); put(portsB[0], pb[0], pb[1]); put(portsB[1], pb[2], pb[3])
  }
  layout()
  new ResizeObserver(layout).observe(or)

  // 점 하나가 선을 따라 이동
  const fly = (path, pkt, ms = 520) => new Promise((res) => {
    if (reduce) return res()
    const len = path.getTotalLength(), t0 = performance.now()
    pkt.style.opacity = 1
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      const pt = path.getPointAtLength(len * e)
      pkt.setAttribute('cx', pt.x); pkt.setAttribute('cy', pt.y)
      if (k < 1) requestAnimationFrame(step); else { pkt.style.opacity = 0; res() }
    }
    requestAnimationFrame(step)
  })

  let run = 0
  const alive = (id) => id === run
  const scroll = (p) => { p.body.scrollTop = p.body.scrollHeight }
  const state = (P, s) => { P.badge.classList.remove('working', 'done'); P.who.classList.remove('working', 'done'); if (s) { P.badge.classList.add(s); P.who.classList.add(s) } }
  // 글자가 한 자씩 쳐지는 효과
  const type = async (node, text, id, cps = 38, pane) => {
    if (reduce) { node.textContent = text; return }
    node.textContent = ''
    for (let i = 1; i <= text.length; i++) {
      if (!alive(id)) return
      node.textContent = text.slice(0, i)
      if (pane) scroll(pane)
      await sleep(1000 / cps + (/[.,·]/.test(text[i - 1]) ? 60 : 0))
    }
  }
  // 입력창에 쳐서 전송 → 대화 영역으로 올라간다
  const compose = async (P, text, id, cps) => {
    await type(P.inp, text, id, cps)
    if (!alive(id)) return
    P.send.classList.add('on'); await sleep(250); P.send.classList.add('go'); await sleep(180)
    P.send.classList.remove('go', 'on'); P.inp.textContent = ''
  }
  const add = (P, node) => { P.p.classList.remove('empty'); P.body.append(node); scroll(P); return node }
  const row = (P, cls, text) => add(P, el('div', 'or-row ' + cls, text))
  const user = (P, text) => { const r = el('div', 'or-row or-user'); r.append(el('div', 'or-bubble', text)); return add(P, r) }
  // WorkBox 한 줄 (client WorkBox.svelte)
  const tool = (P, name, th, ic, arg) => {
    const g = el('div', 'or-group')
    const b = el('span', 'tbadge'); b.style.setProperty('--th', th); b.innerHTML = icon(ic) + `<span>${name}</span>`
    const line = el('span', 'or-line1'); line.append(b, el('code', 'or-sum', arg))
    const meta = el('span', 'or-meta'); meta.innerHTML = `<span class="or-dots"><i></i><i></i><i></i></span><span class="or-chip">${O.ok || ''}</span><span class="or-open">${icon('right')}</span>`
    const box = el('div', 'or-box'); box.append(line, meta)
    g.append(box)
    return add(P, g)
  }

  const play = async () => {
    const id = ++run
    for (const P of [A, B]) { P.body.textContent = ''; P.inp.textContent = ''; P.p.classList.add('empty'); state(P, null) }
    delete anchor.f; delete anchor.b; layout()
    or.classList.remove('flow', 'flow-back')
    replay.hidden = true
    const ok = () => alive(id)

    // 1) 사용자가 철수 창에 요청을 입력
    await sleep(400); if (!ok()) return
    await compose(A, O.ask, id, 40); if (!ok()) return
    user(A, O.ask); state(A, 'working')
    await sleep(300); if (!ok()) return
    // 2) 철수가 답하며 peer_send 호출
    const hand = row(A, 'or-ai'); await type(hand, O.hand, id, 60, A); if (!ok()) return
    await sleep(150)
    const send = tool(A, 'peer_send', 265, 'bolt', `{"to":"${O.b}","message":"${O.msg.slice(0, 18)}…"}`)
    await sleep(350); if (!ok()) return
    // 3) 연결선을 따라 메시지가 건너간다
    anchor.f = send; layout()
    or.classList.add('flow'); await fly(lineF, pktF); if (!ok()) return
    send.classList.add('ok')
    state(A, null); state(B, 'working')
    const peer = el('div', 'or-row or-peer'), bub = el('div', 'or-bubble'), txt = el('div')
    const from = el('div', 'or-from'); from.innerHTML = icon('chat') + `<span></span>`; from.lastChild.textContent = '@' + O.a
    bub.append(from, txt); peer.append(bub); add(B, peer)
    await type(txt, O.msg, id, 90, B); if (!ok()) return
    const sent = row(A, 'or-ai'); type(sent, O.sent, id, 90, A)
    await sleep(400); if (!ok()) return
    or.classList.remove('flow')
    // 4) 미나 쪽 창이 독립적으로 일한다
    const work = row(B, 'or-ai'); await type(work, O.work, id, 75, B); if (!ok()) return
    await sleep(150)
    const w = tool(B, 'write', 150, 'pencil', 'tests/login.test.ts')
    await sleep(750); if (!ok()) return
    w.classList.add('ok')
    const done = row(B, 'or-ai'); await type(done, O.done, id, 75, B); if (!ok()) return
    await sleep(150)
    // 5) 결과가 돌아온다: 미나도 peer_send로 보내고, 철수 창에는 '@미나' 말풍선으로 도착한다 (client: 받은 peer 메시지)
    const back = tool(B, 'peer_send', 265, 'bolt', `{"to":"${O.a}","message":"${O.reply.slice(0, 18)}…"}`)
    await sleep(350); if (!ok()) return
    anchor.b = back; layout()
    or.classList.add('flow-back'); await fly(lineB, pktB); if (!ok()) return
    back.classList.add('ok')
    state(B, 'done'); state(A, 'working')
    const peer2 = el('div', 'or-row or-peer'), bub2 = el('div', 'or-bubble'), txt2 = el('div')
    const from2 = el('div', 'or-from'); from2.innerHTML = icon('chat') + `<span></span>`; from2.lastChild.textContent = '@' + O.b
    bub2.append(from2, txt2); peer2.append(bub2); add(A, peer2)
    await type(txt2, O.reply, id, 90, A); if (!ok()) return
    await sleep(300); if (!ok()) return
    const rep = row(A, 'or-ai'); await type(rep, O.report, id, 75, A); if (!ok()) return
    await sleep(500); or.classList.remove('flow-back'); state(A, 'done'); state(B, null)
    replay.hidden = false
    await sleep(4000); if (ok() && isVisible) play()
  }

  let isVisible = false, started = false
  replay.addEventListener('click', play)
  new IntersectionObserver((es) => {
    isVisible = es.some((e) => e.isIntersecting)
    if (isVisible && !started) { started = true; play() }
  }, { threshold: 0.35 }).observe(root)
})()
