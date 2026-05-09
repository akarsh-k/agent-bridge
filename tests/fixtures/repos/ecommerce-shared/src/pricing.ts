import type { Product } from './product.js'

const CURRENCY_SYMBOL: Record<Product['currency'], string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
}

export function formatPrice(cents: number, currency: Product['currency'] = 'USD'): string {
  const major = (cents / 100).toFixed(2)
  return `${CURRENCY_SYMBOL[currency]}${major}`
}

export function totalCents(products: readonly Product[]): number {
  return products.reduce((acc, p) => acc + p.priceCents, 0)
}

export function applyDiscount(cents: number, percentOff: number): number {
  if (percentOff < 0 || percentOff > 100) {
    throw new RangeError(`percentOff must be 0..100, got ${percentOff}`)
  }
  return Math.round(cents * (1 - percentOff / 100))
}
