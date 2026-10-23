import { STATUS_LABEL, statusOf, summarize, type Status } from './format.js'
import { McpConnection, type ToolResult } from './mcp.js'
import { plan } from './planner.js'
import { canListen, canSpeak, listen, speak, stopSpeaking } from './voice.js'

type Data = Record<string, any>
type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v)
  node.append(...children)
  return node
}

const SVG = 'http://www.w3.org/2000/svg'
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

const mcp = new McpConnection()

// ---- layout: sidebar open = long scrolling page, closed = one-screen dashboard ---------------------
const root = document.documentElement
const expanded = () => root.dataset.layout === 'scroll'
const SECTIONS = [
  { name: 'home', label: 'Home', id: 'home' },
  { name: 'assistant', label: 'Assistant', id: 'chat-card' },
  { name: 'followups', label: 'Follow-ups', id: 'followups-card' },
  { name: 'handover', label: 'Handover', id: 'notes-card' },
  { name: 'container', label: 'Container load', id: 'container-card' },
] as const
let followFilter: 'open' | 'closed' | 'all' = 'open'

// ---- connection + voice state ---------------------------------------------------------------
const CONN_ICON = { connecting: '◌', connected: '●', error: '✕' } as const
function setConn(state: keyof typeof CONN_ICON, text: string) {
  $('conn').dataset.state = state
  $('conn').querySelector('.icon')!.textContent = CONN_ICON[state]
  $('conn-text').textContent = text
  $('chip-dot').dataset.state = state
  $('synthetic-chip').title = text
}

const VOICE_ICON: Record<VoiceState, string> = { idle: '○', listening: '🎙', thinking: '…', speaking: '🔊', error: '⚠' }
function setVoice(state: VoiceState, detail: string) {
  $('voice-strip').dataset.state = state
  $('voice-icon').textContent = VOICE_ICON[state]
  $('voice-state').textContent = state.toUpperCase()
  $('voice-detail').textContent = detail
  ;($('stop-speech') as HTMLButtonElement).disabled = state !== 'speaking'
}

// ---- transcript -----------------------------------------------------------------------------
function addMessage(who: 'You' | 'LineLedger', text: string, kind: 'user' | 'assistant' | 'error' = 'assistant') {
  const li = h('li', { class: `msg ${kind}` }, h('span', { class: 'who' }, who), text)
  $('transcript').append(li)
  li.parentElement!.scrollTop = li.parentElement!.scrollHeight // scroll the transcript only, never the page
}

// ---- dashboard ------------------------------------------------------------------------------
function panel(id: string, state: 'loading' | 'empty' | 'populated' | 'error', ...children: (Node | string)[]) {
  const el = $(id)
  el.dataset.state = state
  el.replaceChildren(...children)
}
const muted = (t: string) => h('p', { class: 'muted' }, t)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function data(name: string, args: Record<string, unknown> = {}): Promise<Data> {
  const r = await mcp.call(name, args)
  if (r.isError) throw new Error(r.content[0]?.text ?? 'Tool error')
  return r.structuredContent ?? {}
}

// Two small vertical-bar charts built from the shift summary. Bars are scaled in CSS; every value is also printed.
function renderBars(lines: Data[]) {
  const group = (title: string, value: (l: Data) => number, max: number, label: (l: Data) => string, worst: Data) =>
    h(
      'div',
      { class: 'bar-group' },
      h('h3', {}, title),
      h(
        'div',
        { class: 'bar-cols' },
        ...lines.map((l) =>
          h(
            'div',
            { class: 'bar-col', 'data-worst': String(l === worst) },
            h('span', { class: 'bar-val' }, label(l)),
            h('div', { class: 'bar-track', role: 'img', 'aria-label': `${l.name}: ${label(l)}` }, h('span', { style: `height:${Math.max(2, Math.min(100, (value(l) / max) * 100))}%` })),
            h('span', { class: 'muted' }, l.name),
          ),
        ),
      ),
    )
  const by = (f: (l: Data) => number, pick: (a: number, b: number) => number) => lines.reduce((a, l) => (pick(f(l), f(a)) === f(l) ? l : a))
  const maxDown = Math.max(1, ...lines.map((l) => l.downtime_min))
  $('bars').dataset.state = 'populated'
  $('bars').replaceChildren(
    group('Output, % of target', (l) => l.percent_of_target, 100, (l) => `${l.percent_of_target}%`, by((l) => l.percent_of_target, Math.min)),
    group('Downtime, minutes', (l) => l.downtime_min, maxDown, (l) => `${l.downtime_min} min`, by((l) => l.downtime_min, Math.max)),
  )
}

// Line chart of percent of target per shift. The SVG only draws geometry (it is stretched to fit); labels are HTML so text stays 14px+.
function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

async function refreshTrend() {
  const box = $('trend')
  try {
    const { shifts } = await data('get_shift_history', { limit: 14 })
    if (shifts.length < 2) {
      box.dataset.state = 'empty'
      return box.replaceChildren(muted('Not enough shift history yet.'))
    }
    const ids = (shifts[0].lines as Data[]).map((l) => l.line_id as string)
    const series = ids.map((id) => ({ id, name: (shifts[0].lines as Data[]).find((l) => l.line_id === id)!.name as string, values: (shifts as Data[]).map((s) => (s.lines as Data[]).find((l) => l.line_id === id)?.percent_of_target as number) }))
    const all = series.flatMap((s) => s.values)
    const lo = Math.min(70, Math.floor(Math.min(...all) / 5) * 5)
    const hi = Math.max(110, Math.ceil(Math.max(...all) / 5) * 5)
    const x = (i: number) => (i / (shifts.length - 1)) * 100
    const y = (v: number) => 100 - ((v - lo) / (hi - lo)) * 100
    const svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': `Percent of target per shift, ${shifts.length} shifts. ${series.map((s) => `${s.name} from ${s.values[0]} to ${s.values.at(-1)} percent`).join('. ')}.` })
    svg.append(svgEl('line', { x1: '0', x2: '100', y1: String(y(100)), y2: String(y(100)), class: 'target', 'vector-effect': 'non-scaling-stroke' }))
    series.forEach((s, n) => svg.append(svgEl('polyline', { points: s.values.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: `series s${n}`, 'vector-effect': 'non-scaling-stroke' })))
    const label = (s: Data) => `${s.shift_date.slice(5)} ${s.shift}`
    box.dataset.state = 'populated'
    box.replaceChildren(
      h('div', { class: 'legend' }, ...series.map((s, n) => h('span', { class: `key k${n}` }, `${s.name} · ${s.values.at(-1)}%`)), h('span', { class: 'key kt' }, 'Target 100%')),
      h('div', { class: 'plot' }, h('div', { class: 'y-axis' }, h('span', {}, `${hi}%`), h('span', {}, `${lo}%`)), svg),
      h('div', { class: 'x-axis' }, h('span', {}, label(shifts[0])), h('span', {}, label(shifts.at(-1)))),
    )
  } catch (e) {
    box.dataset.state = 'error'
    box.replaceChildren(muted(`Could not load shift trend: ${errorText(e)}`))
  }
}

function setStatus(el: HTMLElement, status: Status) {
  el.dataset.status = status
  el.textContent = STATUS_LABEL[status]
}

async function refreshShift() {
  try {
    const d = await data('get_shift_summary')
    const lines = d.lines as Data[]
    const status = statusOf(d.totals.percent_of_target)
    const downtime = lines.reduce((sum, l) => sum + l.downtime_min, 0)
    $('hero-sub').textContent = `Shift ${d.shift} · ${d.shift_date} · output / target`
    $('hero-metric').textContent = `${d.totals.percent_of_target}%`
    setStatus($('hero-status'), status)
    $('hero-meta').textContent = `${d.totals.produced_units} / ${d.totals.target_units} units · downtime ${downtime} min`
    renderBars(lines)
    document.querySelectorAll<HTMLSelectElement>('select[name="line_id"]').forEach((sel) => {
      if (sel.options.length > 1) return
      for (const l of lines) sel.append(h('option', { value: l.line_id }, l.name))
    })
    panel(
      'shift',
      'populated',
      ...lines.map((l) => {
        const st = h('span', { class: 'status' })
        setStatus(st, l.status)
        return h(
          'article',
          { class: 'card stat', 'data-status': l.status },
          h('div', { class: 'stat-head' }, h('span', { class: 'tag' }, l.line_id), h('strong', {}, l.name), st),
          h('p', { class: 'muted' }, l.product),
          h('p', { class: 'stat-value' }, `${l.percent_of_target}%`),
          h('div', { class: 'bar', role: 'img', 'aria-label': `${l.name}: ${l.produced_units} of ${l.target_units}, ${l.percent_of_target} percent` }, h('span', { 'data-status': l.status, style: `width:${Math.min(100, l.percent_of_target)}%` })),
          h('p', { class: 'muted' }, `${l.produced_units} / ${l.target_units} units · downtime ${l.downtime_min} min`),
        )
      }),
    )
  } catch (e) {
    $('hero-sub').textContent = 'Shift output unavailable.'
    $('bars').dataset.state = 'error'
    $('bars').replaceChildren(muted('Shift output unavailable.'))
    panel('shift', 'error', `Could not load shift output: ${errorText(e)}`)
  }
}

const row = (iconName: string, main: (Node | string)[], aside?: Node) =>
  h('li', { class: 'row' }, h('span', { class: 'avatar' }, icon(iconName)), h('div', { class: 'row-main' }, ...main), ...(aside ? [aside] : []))

async function refreshNotes() {
  try {
    const { notes } = await data('list_handover_notes', { limit: expanded() ? 50 : 2 })
    if (!notes.length) return panel('notes', 'empty', muted('No handover notes yet.'))
    panel('notes', 'populated', h('ul', { class: 'rows' }, ...(notes as Data[]).map((n) => row('note', [n.text, h('span', { class: 'muted' }, `${n.line_id ?? 'All lines'} · ${n.author} · ${String(n.created_at).slice(0, 16).replace('T', ' ')}`)]))))
  } catch (e) {
    panel('notes', 'error', `Could not load notes: ${errorText(e)}`)
  }
}

async function refreshFollowUps() {
  try {
    const status = expanded() ? followFilter : 'open' // the compact card and the badge always mean open items
    const { follow_ups } = await data('list_follow_ups', { status })
    if (status !== 'closed') $('followup-count').textContent = String((follow_ups as Data[]).filter((f) => f.status === 'open').length)
    if (!follow_ups.length) return panel('followups', 'empty', muted(status === 'closed' ? 'No closed follow-ups.' : 'No open follow-ups.'))
    panel(
      'followups',
      'populated',
      h(
        'ul',
        { class: 'rows' },
        ...(follow_ups as Data[]).map((f) => {
          const meta = h('span', { class: 'muted' }, `${f.owner}${f.due_date ? ` · due ${f.due_date}` : ''}${f.line_id ? ` · ${f.line_id}` : ''}`)
          if (f.status === 'closed') return row('list', [`#${f.id} ${f.title}`, meta], h('span', { class: 'muted' }, 'Closed'))
          const close = h('button', { type: 'button', 'aria-label': `Close follow-up ${f.id}: ${f.title}` }, 'Close')
          close.addEventListener('click', () => void send(`close follow-up ${f.id}`, false, false))
          return row('list', [`#${f.id} ${f.title}`, meta], close)
        }),
      ),
    )
  } catch (e) {
    panel('followups', 'error', `Could not load follow-ups: ${errorText(e)}`)
  }
}

function showContainer(d: Data) {
  const meter = (label: string, fraction: number, detail: string) =>
    h(
      'div',
      { class: 'meter' },
      h('div', { class: 'meter-head' }, h('span', { class: 'muted' }, label), h('strong', {}, detail)),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${label}: ${detail}` }, h('span', { 'data-status': 'accent', style: `width:${Math.min(100, fraction * 100)}%` })),
    )
  // One layer, drawn from the grid: along x across cells (capped so a big result stays readable).
  const cols = Math.min(d.grid.across, 24)
  const rowsN = Math.min(d.grid.along, 24)
  const layer = h('div', { class: 'layer', role: 'img', 'aria-label': `One layer: ${d.grid.along} by ${d.grid.across} boxes, ${d.grid.layers} layers high`, style: `grid-template-columns:repeat(${cols},1fr)` }, ...Array.from({ length: cols * rowsN }, () => h('span')))
  panel(
    'container',
    'populated',
    h('p', { class: 'metric' }, `${d.count} boxes`),
    h('p', { class: 'muted' }, `Limited by ${d.limitedBy} · ${d.grid.along} × ${d.grid.across} × ${d.grid.layers} layers · placed ${d.orientation.length} × ${d.orientation.width} × ${d.orientation.height} mm`),
    layer,
    h('div', { class: 'meters' }, meter('Volume', d.volumeUtilisation, `${Math.round(d.volumeUtilisation * 100)}%`), meter('Payload', d.payloadUtilisation, `${Math.round(d.payloadUtilisation * 100)}% · ${d.totalWeightKg} kg`)),
  )
}

const refreshAll = () => Promise.all([refreshShift(), refreshTrend(), refreshNotes(), refreshFollowUps()])

// ---- planner mode: deterministic rules (default) or the agent service (local Ollama or Amazon Bedrock) ----
let modelMode = false
type AgentReply = { reply: string; tool_calls: { name: string }[]; seconds: number; model: string; provider?: string; usage?: { totalTokens: number } | null }
async function askAgent(text: string): Promise<AgentReply> {
  const res = await fetch('/agent/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  const body = (await res.json().catch(() => ({}))) as Data
  if (!res.ok) throw new Error(body.error ?? `agent service returned HTTP ${res.status}`)
  return body as never
}

// ---- sending a request ----------------------------------------------------------------------
let busy = false
async function send(text: string, fromVoice: boolean, navigate = true) {
  if (busy || !text.trim()) return
  if (navigate && expanded() && activeSection !== 'assistant') scrollToSection('chat-card') // the answer appears in the chat
  busy = true
  addMessage('You', text, 'user')
  if (modelMode) {
    setVoice('thinking', 'The agent model is working. A local model can take a while on CPU.')
    try {
      const r = await askAgent(text)
      const tools = r.tool_calls.map((c) => c.name).join(', ') || 'none'
      const where = r.provider === 'bedrock' ? 'Amazon Bedrock' : 'local model'
      const tokens = r.usage ? ` · ${r.usage.totalTokens} tokens` : ''
      addMessage('LineLedger', `${r.reply}\n[${where} ${r.model} · ${r.seconds} s${tokens} · tools: ${tools}]`)
      void refreshAll()
      finish(r.reply, fromVoice)
    } catch (e) {
      const message = `Agent model unavailable: ${errorText(e)}. Switch the planner back to rules.`
      addMessage('LineLedger', message, 'error')
      setVoice('error', message)
    } finally {
      busy = false
    }
    return
  }
  const p = plan(text)
  if (p.kind === 'help') {
    addMessage('LineLedger', p.message)
    finish(p.message, fromVoice)
    busy = false
    return
  }
  setVoice('thinking', `Calling ${p.tool}`)
  if (p.tool === 'plan_container_load') panel('container', 'loading', muted('Calculating...'))
  try {
    const r: ToolResult = await mcp.call(p.tool, p.args)
    if (r.isError) {
      const message = r.content[0]?.text ?? 'The tool reported an error.'
      addMessage('LineLedger', message, 'error')
      if (p.tool === 'plan_container_load') panel('container', 'error', `Invalid input or error: ${message}`)
      setVoice('error', message)
      return
    }
    const d = r.structuredContent ?? {}
    const reply = summarize(p.tool, d)
    addMessage('LineLedger', reply)
    if (p.tool === 'plan_container_load') showContainer(d)
    if (p.tool === 'create_handover_note') void refreshNotes()
    if (p.tool === 'create_follow_up' || p.tool === 'close_follow_up') void refreshFollowUps()
    finish(reply, fromVoice)
  } catch (e) {
    const message = `Request failed: ${errorText(e)}`
    addMessage('LineLedger', message, 'error')
    setVoice('error', message)
    setConn('error', 'MCP error')
  } finally {
    busy = false
  }
}

function finish(reply: string, fromVoice: boolean) {
  if (fromVoice && canSpeak) {
    setVoice('speaking', 'Press Stop speaking or Escape to interrupt.')
    speak(reply, () => setVoice('idle', 'Type or press Listen.'))
  } else {
    setVoice('idle', 'Type or press Listen.')
  }
}

// ---- trace panel ----------------------------------------------------------------------------
function traceLabel(e: Data): string {
  const m = e.message ?? {}
  const kind = m.method ?? (m.error ? 'error' : 'result')
  const tool = m.method === 'tools/call' ? ` ${m.params?.name}` : ''
  return `${e.dir === 'in' ? '→ request' : '← response'} ${kind}${tool}${m.id !== undefined ? ` (id ${m.id})` : ''}`
}
const PULSE_CELLS = 42
const pulse: ('in' | 'out' | 'err')[] = []
let traceCount = 0
function drawPulse() {
  $('trace-count').textContent = String(traceCount)
  $('trace-pulse').replaceChildren(...Array.from({ length: PULSE_CELLS }, (_, i) => h('span', { 'data-kind': pulse[i - (PULSE_CELLS - pulse.length)] ?? 'none' })))
}
function startTrace() {
  const list = $('trace-list')
  drawPulse()
  const es = new EventSource('/api/trace/stream')
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data) as Data
    list.append(h('li', {}, h('details', {}, h('summary', {}, h('span', { class: `dir ${e.dir}` }, traceLabel(e))), h('pre', {}, JSON.stringify(e.message, null, 2)))))
    while (list.children.length > 200) list.firstElementChild!.remove()
    list.scrollTop = list.scrollHeight
    pulse.push(e.message?.error ? 'err' : e.dir)
    if (pulse.length > PULSE_CELLS) pulse.shift()
    traceCount++
    drawPulse()
  }
}

const traceDialog = $('trace-dialog') as HTMLDialogElement
function openTrace() {
  traceDialog.showModal()
  $('trace-list').scrollTop = $('trace-list').scrollHeight
}
$('trace-card').addEventListener('click', openTrace)
$('open-trace').addEventListener('click', (ev) => {
  ev.preventDefault()
  openTrace()
})
traceDialog.addEventListener('click', (ev) => {
  if (ev.target === traceDialog) traceDialog.close() // click on the backdrop
})

// ---- wiring ---------------------------------------------------------------------------------
const input = $('text') as HTMLInputElement
$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const text = input.value
  input.value = ''
  void send(text, false)
})
document.querySelectorAll<HTMLButtonElement>('[data-say]').forEach((b) => b.addEventListener('click', () => void send(b.dataset.say!, false)))

const listenBtn = $('listen') as HTMLButtonElement
let stopListening: (() => void) | null = null
function endListening() {
  stopListening = null
  listenBtn.setAttribute('aria-pressed', 'false')
  if ($('voice-strip').dataset.state === 'listening') setVoice('idle', 'Type or press Listen.')
}
listenBtn.addEventListener('click', () => {
  if (stopListening) return stopListening()
  stopSpeaking()
  listenBtn.setAttribute('aria-pressed', 'true')
  setVoice('listening', 'Speak now. Press Listen again to cancel.')
  stopListening = listen({
    onText: (t) => void send(t, true),
    onError: (m) => {
      setVoice('error', m)
      addMessage('LineLedger', m, 'error')
    },
    onEnd: endListening,
  })
})
if (!canListen) listenBtn.title = 'Speech recognition is not supported in this browser. Type instead.'
const modeBtn = $('mode') as HTMLButtonElement
modeBtn.addEventListener('click', () => {
  modelMode = !modelMode
  modeBtn.setAttribute('aria-pressed', String(modelMode))
  modeBtn.textContent = modelMode ? 'Planner: agent model' : 'Planner: rules (no LLM)'
})
$('stop-speech').addEventListener('click', () => {
  stopSpeaking()
  setVoice('idle', 'Speech stopped.')
})
// "/" or Ctrl/Cmd+K focuses the command bar (unless already typing somewhere).
document.addEventListener('keydown', (ev) => {
  const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement
  if ((ev.key === '/' && !typing) || (ev.key.toLowerCase() === 'k' && (ev.ctrlKey || ev.metaKey))) {
    ev.preventDefault()
    input.focus()
  }
})
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  stopSpeaking()
  stopListening?.()
  if ($('voice-strip').dataset.state === 'speaking') setVoice('idle', 'Speech stopped.')
})

// ---- views, forms, theme ------------------------------------------------------------------------
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const content = $('content')
// Desktop scrolls .content; below 1100px the page itself scrolls.
const scroller = () => (content.scrollHeight > content.clientHeight + 1 && getComputedStyle(content).overflowY !== 'visible' ? content : (document.scrollingElement as HTMLElement))
const edgeTop = () => (scroller() === content ? content.getBoundingClientRect().top : 0)

let scrollAnim = 0
function scrollToSection(id: string) {
  const el = $(id)
  const box = scroller()
  const target = id === 'home' ? 0 : Math.max(0, box.scrollTop + el.getBoundingClientRect().top - edgeTop() - 16)
  cancelAnimationFrame(scrollAnim)
  const from = box.scrollTop
  const dist = target - from
  const ms = reduceMotion() ? 0 : Math.min(1800, 800 + Math.abs(dist) * 0.5) // long, but longer trips take longer
  if (!ms || !dist) return void (box.scrollTop = target)
  const t0 = performance.now()
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms)
    box.scrollTop = from + dist * (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2) // ease in-out cubic
    if (p < 1) scrollAnim = requestAnimationFrame(step)
  }
  scrollAnim = requestAnimationFrame(step)
}

// Scrollspy: the last section whose top has passed the top edge is current.
let activeSection = 'home'
function spy() {
  let name: string = 'home'
  if (expanded()) {
    const box = scroller()
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4
    for (const sec of SECTIONS) if ($(sec.id).getBoundingClientRect().top - edgeTop() <= 160) name = sec.name
    if (atEnd) name = SECTIONS.at(-1)!.name
  }
  activeSection = name
  $('crumb-view').textContent = SECTIONS.find((x) => x.name === name)!.label
  document.querySelectorAll<HTMLAnchorElement>('.nav a[data-view]').forEach((a) => (a.dataset.view === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
}
content.addEventListener('scroll', spy, { passive: true })
window.addEventListener('scroll', spy, { passive: true })
window.addEventListener('resize', spy)

document.querySelectorAll<HTMLAnchorElement>('.nav a[data-view]').forEach((a) =>
  a.addEventListener('click', (ev) => {
    ev.preventDefault()
    const sec = SECTIONS.find((x) => x.name === a.dataset.view)!
    scrollToSection(sec.id)
    try {
      history.replaceState(null, '', `#${sec.id}`)
    } catch {
      // not essential
    }
  }),
)

function applyLayout() {
  const open = expanded()
  document.querySelectorAll<HTMLElement>('[data-expanded]').forEach((el) => (el.hidden = !open))
  void Promise.all([refreshNotes(), refreshFollowUps()]) // list sizes and the filter depend on the layout
  spy()
}

// Toggle: the sidebar starts sliding at once; the content fades out, switches layout while hidden, then fades in.
const toggle = $('sidebar-toggle') as HTMLButtonElement
let switching = false
function setSidebar(open: boolean) {
  if (switching) return
  switching = true
  root.dataset.sidebar = open ? 'open' : 'closed'
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar')
  try {
    localStorage.setItem('sidebar', open ? 'open' : 'closed')
  } catch {
    // the choice still applies for this visit
  }
  const wait = reduceMotion() ? 0 : 500
  content.classList.add('swap')
  setTimeout(() => {
    root.dataset.layout = open ? 'scroll' : 'compact'
    scroller().scrollTop = 0
    applyLayout()
    requestAnimationFrame(() => content.classList.remove('swap'))
    setTimeout(() => (switching = false), wait)
  }, wait)
}
toggle.addEventListener('click', () => setSidebar(root.dataset.sidebar !== 'open'))
toggle.setAttribute('aria-expanded', String(root.dataset.sidebar === 'open'))
toggle.setAttribute('aria-label', root.dataset.sidebar === 'open' ? 'Close sidebar' : 'Open sidebar')
applyLayout()

document.querySelectorAll<HTMLButtonElement>('.seg [data-filter]').forEach((b) =>
  b.addEventListener('click', () => {
    followFilter = b.dataset.filter as typeof followFilter
    document.querySelectorAll<HTMLButtonElement>('.seg [data-filter]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
    void refreshFollowUps()
  }),
)

function bindForm(id: string, submit: (f: FormData) => Promise<string>) {
  const form = $(id) as HTMLFormElement
  const msg = form.querySelector<HTMLElement>('.form-msg')!
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    btn.disabled = true
    msg.dataset.state = ''
    msg.textContent = 'Working...'
    try {
      msg.textContent = await submit(new FormData(form))
      msg.dataset.state = 'ok'
    } catch (e) {
      msg.textContent = errorText(e)
      msg.dataset.state = 'error'
    } finally {
      btn.disabled = false
    }
  })
}
const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

bindForm('followup-form', async (f) => {
  const d = await data('create_follow_up', { title: field(f, 'title'), owner: field(f, 'owner'), ...(field(f, 'line_id') && { line_id: field(f, 'line_id') }), ...(field(f, 'due_date') && { due_date: field(f, 'due_date') }) })
  ;($('followup-form') as HTMLFormElement).reset()
  void refreshFollowUps()
  return `Added follow-up #${d.id}.`
})
bindForm('note-form', async (f) => {
  const d = await data('create_handover_note', { author: field(f, 'author'), text: field(f, 'text'), ...(field(f, 'line_id') && { line_id: field(f, 'line_id') }) })
  const text = $('note-form').querySelector<HTMLTextAreaElement>('textarea')!
  text.value = ''
  void refreshNotes()
  return `Saved note #${d.id}.`
})
bindForm('container-form', async (f) => {
  panel('container', 'loading', muted('Calculating...'))
  try {
    const d = await data('plan_container_load', {
      container_type: field(f, 'container_type'),
      box_length_mm: Number(field(f, 'box_length_mm')),
      box_width_mm: Number(field(f, 'box_width_mm')),
      box_height_mm: Number(field(f, 'box_height_mm')),
      box_weight_kg: Number(field(f, 'box_weight_kg')),
      rotation: field(f, 'rotation'),
    })
    showContainer(d)
    return `${d.count} boxes fit, limited by ${d.limitedBy}.`
  } catch (e) {
    panel('container', 'error', `Invalid input or error: ${errorText(e)}`)
    throw e
  }
})

const themeBtn = $('theme') as HTMLButtonElement
themeBtn.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'light'))
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  themeBtn.setAttribute('aria-pressed', String(next === 'light'))
  try {
    localStorage.setItem('theme', next)
  } catch {
    // private mode or blocked storage: the theme still applies for this visit
  }
})

// ---- start ----------------------------------------------------------------------------------
startTrace()
void (async () => {
  try {
    await mcp.connect()
    // Which store the server runs on (SQLite by default, Amazon DynamoDB when LINELEDGER_STORE=dynamodb).
    const health = (await fetch('/api/health').then((r) => r.json()).catch(() => ({}))) as { store?: string }
    const store = health.store === 'dynamodb' ? ' · store: Amazon DynamoDB' : health.store === 'sqlite' ? ' · store: SQLite' : ''
    setConn('connected', `MCP connected · protocol ${mcp.protocolVersion}${store}`)
    addMessage('LineLedger', 'Ready. All data is synthetic demo data. Ask about shift output, handover notes, follow-ups, stock or container loads.')
    await mcp.listTools()
    await refreshAll()
  } catch (e) {
    setConn('error', 'MCP not reachable')
    setVoice('error', `Cannot reach the MCP server: ${errorText(e)}`)
    for (const id of ['shift', 'notes', 'followups', 'trend']) panel(id, 'error', 'Server unreachable. Start it with: npm run dev:server')
  }
})()
