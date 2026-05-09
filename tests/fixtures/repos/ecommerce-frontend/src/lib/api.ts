import { ApiError, type ProductListResponse } from '@ecommerce/shared'

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // body wasn't JSON — fall through with null
    }
    throw ApiError.fromResponse(res.status, body)
  }
  return (await res.json()) as T
}

export function fetchProducts(): Promise<ProductListResponse> {
  return fetchJson<ProductListResponse>('/products')
}
