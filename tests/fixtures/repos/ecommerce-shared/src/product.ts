/**
 * Canonical Product shape for the ecommerce demo.
 *
 * Mirrored on the backend as a Pydantic model — they MUST stay in sync.
 * The agent's `repo_edges` row records this correspondence so
 * `assess_change_impact` lights up the backend when the TS interface
 * changes.
 */
export interface Product {
  id: string
  name: string
  description: string
  /** Price in the smallest currency unit (cents). */
  priceCents: number
  currency: 'USD' | 'EUR' | 'GBP'
  inStock: boolean
}

export interface ProductListResponse {
  products: readonly Product[]
  total: number
}

export function isProduct(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['priceCents'] === 'number'
  )
}
