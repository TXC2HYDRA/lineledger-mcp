// Deterministic, rule-based planner: maps one operator request to one MCP tool call.
// No LLM involved. The optional agent service (agent/) is the model-backed alternative.
export type Plan =
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | { kind: 'help'; message: string }

const CONTAINERS = {
  '20': { length: 5898, width: 2352, height: 2393, maxPayloadKg: 28200 },
  '40': { length: 12032, width: 2352, height: 2393, maxPayloadKg: 26700 },
} as const

const STOPWORDS = new Set(
  `a an the of for on in at to do we i you is are it our my need needs should check checking stock stocks inventory
  reorder reorder order orders purchase buy running low how much many what whats any there have has get me please
  and or with about status level levels supply supplies item items`.split(/\s+/),
)

const HELP =
  'Try: "how are the lines doing right now", "why is line 2 down", "is the sealer temperature normal", "shift summary", ' +
  '"show the trend for the last 10 shifts", "plant events", "receive 20000 kg hdpe", "add handover note for line 2: sealer jaw ran hot", ' +
  '"open follow-ups", "add follow-up: re-check guard, owner Ravi, line 2", "close follow-up 3", "stock of hdpe", ' +
  'or "how many 600x400x300 12kg boxes fit in a 20ft container".'

const SKUS: [RegExp, string][] = [
  [/\b(hdpe|granules?|poly)\b/, 'PLY-HDPE'],
  [/\b(steel|strip)\b/, 'STL-040'],
  [/\b(heater|bands?)\b/, 'HTR-BAND'],
  [/\b(labels?)\b/, 'LBL-ROLL'],
  [/\b(film|shrink)\b/, 'FLM-SHR'],
]
const skuOf = (text: string): string | undefined =>
  /\b([a-z]{3}-[a-z0-9]{3,8})\b/i.exec(text)?.[1]?.toUpperCase() ?? SKUS.find(([re]) => re.test(text.toLowerCase()))?.[1]

const lineOf = (t: string): string | undefined => {
  const m = /\bline\s*#?\s*(\d+)/i.exec(t)
  return m ? `L${m[1]}` : undefined
}
const afterColon = (t: string): string => {
  const i = t.indexOf(':')
  return i === -1 ? '' : t.slice(i + 1).trim()
}

export function plan(input: string): Plan {
  const text = input.trim()
  const t = text.toLowerCase()
  if (!text) return { kind: 'help', message: HELP }
  const line_id = lineOf(t)

  // Follow-ups
  if (/\bfollow[\s-]?ups?\b/.test(t)) {
    if (/\b(close|complete|finish|resolve)\b/.test(t)) {
      const m = /follow[\s-]?up\s*#?\s*(\d+)|(\d+)/.exec(t)
      const id = Number(m?.[1] ?? m?.[2])
      if (!id) return { kind: 'help', message: 'Which follow-up? Say: close follow-up 3.' }
      return { kind: 'call', tool: 'close_follow_up', args: { id } }
    }
    if (/\b(add|create|new|log|raise)\b/.test(t)) {
      const owner = /\b(?:owner|assigned to|assign to)\s+([a-z][\w'-]*)/i.exec(text)?.[1]
      const due = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1]
      let title = afterColon(text) || text.replace(/^.*?follow[\s-]?ups?\s*(to|for)?/i, '')
      title = title
        .replace(/[,;]?\s*\b(?:owner|assigned to|assign to)\s+[a-z][\w'-]*/gi, '')
        .replace(/[,;]?\s*\bdue\s+\d{4}-\d{2}-\d{2}/gi, '')
        .replace(/[,;]?\s*\bline\s*#?\s*\d+/gi, '')
        .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
      if (!title) return { kind: 'help', message: 'What is the follow-up? Say: add follow-up: <task>, owner <name>, due 2026-10-22, line 2.' }
      if (!owner) return { kind: 'help', message: 'Who owns it? Say: add follow-up: <task>, owner <name>.' }
      return { kind: 'call', tool: 'create_follow_up', args: { title, owner, ...(line_id && { line_id }), ...(due && { due_date: due }) } }
    }
    const status = /\bclosed\b/.test(t) ? 'closed' : /\ball\b/.test(t) ? 'all' : 'open'
    return { kind: 'call', tool: 'list_follow_ups', args: { status, ...(line_id && { line_id }) } }
  }

  // Handover notes
  if (/\bhandover\b|\bhand-over\b|\bnotes?\b/.test(t)) {
    if (/\b(add|create|save|leave|write|log|record)\b/.test(t)) {
      const body = afterColon(text)
      if (!body) return { kind: 'help', message: 'What should the note say? Say: add handover note for line 2: <text>.' }
      return { kind: 'call', tool: 'create_handover_note', args: { author: 'Operator', text: body, ...(line_id && { line_id }) } }
    }
    return { kind: 'call', tool: 'list_handover_notes', args: { limit: 10, ...(line_id && { line_id }) } }
  }

  // Simulation: goods receipt
  if (/\b(receive|received|receipt|delivered|delivery|book in|goods in)\b/.test(t)) {
    const sku = skuOf(text)
    const qty = Number(/\b(\d[\d,]*)\b/.exec(t.replace(/\b[a-z]{3}-[a-z0-9]+\b/g, ''))?.[1]?.replace(/,/g, ''))
    if (!sku) return { kind: 'help', message: 'Which item arrived? Say: receive 2500 kg hdpe, or receive 6 heater bands.' }
    if (!qty) return { kind: 'help', message: 'How much arrived? Say: receive 2500 kg hdpe.' }
    return { kind: 'call', tool: 'receive_stock', args: { sku, quantity: qty } }
  }

  // Container load
  const dims = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/.exec(t)
  if (dims && /\b(container|fit|fits|load|pack|boxes?|cartons?|crates?)\b/.test(t)) {
    const scale = dims[4] === 'cm' ? 10 : 1
    const [length, width, height] = [dims[1], dims[2], dims[3]].map((v) => Number(v) * scale) as [number, number, number]
    const weight = /(\d+(?:\.\d+)?)\s*kg/.exec(t)
    if (!weight) return { kind: 'help', message: 'How heavy is one box? Say: how many 600x400x300 12kg boxes fit in a 20ft container.' }
    const size = /\b40\s*-?\s*(ft|foot|feet)/.test(t) ? '40' : '20'
    return {
      kind: 'call',
      tool: 'plan_container_load',
      args: {
        container: CONTAINERS[size],
        item: { length, width, height, weightKg: Number(weight[1]) },
        rotation: /\b(any|tip|tilt|rotate|sideways)\b/.test(t) ? 'any' : 'upright',
      },
    }
  }

  // Stock and purchasing
  if (/\b(stock|inventory|reorder|order|purchase|buy|running low|low on|supply|supplies)\b/.test(t)) {
    const words = t.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w))
    const query = words.sort((a, b) => b.length - a.length)[0]
    if (!query) return { kind: 'help', message: 'Which item? Say: stock of hdpe.' }
    return { kind: 'call', tool: 'check_stock', args: { query } }
  }

  // Plant event log
  if (/\b(events?|what happened|andon|log)\b/.test(t)) {
    return { kind: 'call', tool: 'get_factory_events', args: { limit: 10, ...(line_id && { line_id }) } }
  }

  // Trend over recent shifts
  if (/\b(trend|history)\b/.test(t)) {
    const n = Number(/\blast\s+(\d+)\s+shifts?\b/.exec(t)?.[1])
    return { kind: 'call', tool: 'get_shift_history', args: { limit: Math.min(60, Math.max(2, n || 14)) } }
  }

  // Live plant: placed before the shift rule, which would otherwise catch "line 2" through "lines?"
  if (/\b(why|down|stopped|running|right now|live|temperature|temp|alarms?|status|sealer)\b/.test(t)) {
    // The heat sealer and its jaw-temperature sensor exist only on Line 2 (plant/plant.json).
    const line = line_id ?? (/\b(sealer|jaw|temperature|temp)\b/.test(t) ? 'L2' : undefined)
    return { kind: 'call', tool: 'get_live_line_status', args: line ? { line_id: line } : {} }
  }

  // Shift summary
  if (/\b(shift|output|target|production|summary|lines?|how are we|how are the)\b/.test(t)) {
    const shift = /\bshift\s+([abc])\b/.exec(t)?.[1]?.toUpperCase()
    return { kind: 'call', tool: 'get_shift_summary', args: shift ? { shift } : {} }
  }

  return { kind: 'help', message: HELP }
}
