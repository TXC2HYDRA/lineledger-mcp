// Business thresholds shared by the MCP tools and the scheduled shift report (lambda/shift-report.ts).
export const percentOf = (produced: number, target: number) => Math.round((produced / target) * 1000) / 10

export const lineStatus = (percent: number) =>
  percent >= 95 ? ('on_track' as const) : percent >= 80 ? ('at_risk' as const) : ('behind' as const)

export const stockStatus = (onHand: number, reorderPoint: number) =>
  onHand === 0 ? ('out_of_stock' as const) : onHand <= reorderPoint ? ('reorder' as const) : ('ok' as const)
