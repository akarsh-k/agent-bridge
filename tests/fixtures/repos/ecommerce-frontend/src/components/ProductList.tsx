import { useProducts } from '../hooks/useProducts.js'
import { ProductCard } from './ProductCard.js'

export function ProductList(): JSX.Element {
  const { products, loading, error } = useProducts()

  if (loading) return <p>Loading products…</p>
  if (error) return <p className="error">Failed to load: {error.message}</p>
  if (products.length === 0) return <p>No products available.</p>

  return (
    <ul className="product-list">
      {products.map((p) => (
        <li key={p.id}>
          <ProductCard product={p} />
        </li>
      ))}
    </ul>
  )
}
