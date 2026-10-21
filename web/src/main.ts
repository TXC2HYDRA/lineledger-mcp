import { summarize } from './format.js'
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

const mcp = new McpConnection()

// ---- connection + voice state ---------------------------------------------------------------
const CONN_ICON = { connecting: '◌', connected: '●', error: '✕' } as const
function setConn(state: keyof typeof CONN_ICON, text: string) {
  $('conn').dataset.state = state
  $('conn').querySelector('.icon')!.textContent = CONN_ICON[state]
  $('conn-text').textContent = text
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
  li.scrollIntoView({ block: 'end' })
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

async function refreshShift() {
  try {
    const d = await data('get_shift_summary')
    panel(
      'shift',
      'populated',
      h('p', { class: 'muted' }, `Shift ${d.shift} · ${d.shift_date} · output / target`),
      h('p', { class: 'metric' }, `${d.totals.percent_of_target}%`),
      ...(d.lines as Data[]).map((l) =>
        h(
          'div',
          { class: 'line-row' },
          h('div', { class: 'line-head' }, h('span', {}, `${l.name} · ${l.product}`), h('span', { class: 'status', 'data-status': l.status }, `${l.status.replace('_', ' ').toUpperCase()}`)),
          h('div', { class: 'bar', role: 'img', 'aria-label': `${l.name}: ${l.produced_units} of ${l.target_units}, ${l.percent_of_target} percent` }, h('span', { 'data-status': l.status, style: `width:${Math.min(100, l.percent_of_target)}%` })),
          h('span', { class: 'muted' }, `${l.produced_units} / ${l.target_units} units · downtime ${l.downtime_min} min`),
        ),
      ),
    )
  } catch (e) {
    panel('shift', 'error', `Could not load shift output: ${errorText(e)}`)
  }
}

async function refreshNotes() {
  try {
    const { notes } = await data('list_handover_notes', { limit: 5 })
    if (!notes.length) return panel('notes', 'empty', muted('No handover notes yet.'))
    panel('notes', 'populated', h('ul', {}, ...(notes as Data[]).map((n) => h('li', {}, h('span', { class: 'muted' }, `${n.line_id ?? 'All lines'} · ${n.author}`), h('br'), n.text))))
  } catch (e) {
    panel('notes', 'error', `Could not load notes: ${errorText(e)}`)
  }
}

async function refreshFollowUps() {
  try {
    const { follow_ups } = await data('list_follow_ups', { status: 'open' })
    if (!follow_ups.length) return panel('followups', 'empty', muted('No open follow-ups.'))
    panel(
      'followups',
      'populated',
      h(
        'ul',
        {},
        ...(follow_ups as Data[]).map((f) => {
          const close = h('button', { type: 'button', 'aria-label': `Close follow-up ${f.id}: ${f.title}` }, 'Close')
          close.addEventListener('click', () => void send(`close follow-up ${f.id}`, false))
          return h('li', { class: 'followup' }, h('span', {}, `#${f.id} ${f.title}`, h('br'), h('span', { class: 'muted' }, `${f.owner}${f.due_date ? ` · due ${f.due_date}` : ''}${f.line_id ? ` · ${f.line_id}` : ''}`)), close)
        }),
      ),
    )
  } catch (e) {
    panel('followups', 'error', `Could not load follow-ups: ${errorText(e)}`)
  }
}

function showContainer(d: Data) {
  const row = (k: string, v: string) => h('li', {}, h('span', { class: 'muted' }, `${k}: `), v)
  panel(
    'container',
    'populated',
    h('p', { class: 'metric' }, `${d.count} boxes`),
    h(
      'ul',
      {},
      row('Limited by', d.limitedBy),
      row('Grid', `${d.grid.along} × ${d.grid.across} × ${d.grid.layers} layers`),
      row('Placed as (mm)', `${d.orientation.length} × ${d.orientation.width} × ${d.orientation.height}`),
      row('Volume used', `${Math.round(d.volumeUtilisation * 100)}%`),
      row('Payload used', `${Math.round(d.payloadUtilisation * 100)}% (${d.totalWeightKg} kg)`),
    ),
  )
}

const refreshAll = () => Promise.all([refreshShift(), refreshNotes(), refreshFollowUps()])

// ---- sending a request ----------------------------------------------------------------------
let busy = false
async function send(text: string, fromVoice: boolean) {
  if (busy || !text.trim()) return
  busy = true
  addMessage('You', text, 'user')
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
function startTrace() {
  const list = $('trace-list')
  const es = new EventSource('/api/trace/stream')
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data) as Data
    list.append(h('li', {}, h('details', {}, h('summary', {}, h('span', { class: `dir ${e.dir}` }, traceLabel(e))), h('pre', {}, JSON.stringify(e.message, null, 2)))))
    while (list.children.length > 200) list.firstElementChild!.remove()
    list.lastElementChild!.scrollIntoView({ block: 'end' })
  }
}

// ---- wiring ---------------------------------------------------------------------------------
const input = $('text') as HTMLInputElement
$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const text = input.value
  input.value = ''
  void send(text, false)
})
document.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.addEventListener('click', () => void send(b.dataset.say!, false)))

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
$('stop-speech').addEventListener('click', () => {
  stopSpeaking()
  setVoice('idle', 'Speech stopped.')
})
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  stopSpeaking()
  stopListening?.()
  if ($('voice-strip').dataset.state === 'speaking') setVoice('idle', 'Speech stopped.')
})

// ---- start ----------------------------------------------------------------------------------
startTrace()
void (async () => {
  try {
    await mcp.connect()
    setConn('connected', `MCP connected · protocol ${mcp.protocolVersion}`)
    addMessage('LineLedger', 'Ready. All data is synthetic demo data. Ask about shift output, handover notes, follow-ups, stock or container loads.')
    await mcp.listTools()
    await refreshAll()
  } catch (e) {
    setConn('error', 'MCP not reachable')
    setVoice('error', `Cannot reach the MCP server: ${errorText(e)}`)
    for (const id of ['shift', 'notes', 'followups']) panel(id, 'error', 'Server unreachable. Start it with: npm run dev:server')
  }
})()
