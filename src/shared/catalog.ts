export const CHANNEL = '/workspace-chain'
export interface TargetSummary { name: string; purpose: string; aliases: string[] }
export interface Catalog { toolName: string; targets: TargetSummary[] }
export function mention(name: string): string { return `@workspace/${encodeURIComponent(name)}` }
export function isCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== 'object') return false
  const obj = value as Catalog
  return typeof obj.toolName === 'string' && Array.isArray(obj.targets) && obj.targets.every(t =>
    t && typeof t.name === 'string' && typeof t.purpose === 'string' && Array.isArray(t.aliases) && t.aliases.every(a => typeof a === 'string'))
}
