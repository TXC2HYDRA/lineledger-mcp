// Adapter for the standalone container-load-planner package (separate MIT repo).
// ponytail: dynamic import so the server runs before that dependency is installed;
// swap for a static import once it is in package.json.
export interface PlanFn {
  (input: unknown): Record<string, unknown>
}

export async function loadPlanner(): Promise<PlanFn | null> {
  const name = 'container-load-planner'
  try {
    const mod = (await import(name)) as { planContainerLoad?: PlanFn }
    return mod.planContainerLoad ?? null
  } catch {
    return null
  }
}
