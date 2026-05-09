import { useEffect, useState } from 'react'
import { ApiError, type Product } from '@ecommerce/shared'

import { fetchProducts } from '../lib/api.js'

export interface UseProductsState {
  products: readonly Product[]
  loading: boolean
  error: ApiError | null
}

export function useProducts(): UseProductsState {
  const [state, setState] = useState<UseProductsState>({
    products: [],
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    fetchProducts()
      .then((response) => {
        if (cancelled) return
        setState({ products: response.products, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const error = err instanceof ApiError ? err : new ApiError('client_error', String(err), 0)
        setState({ products: [], loading: false, error })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
