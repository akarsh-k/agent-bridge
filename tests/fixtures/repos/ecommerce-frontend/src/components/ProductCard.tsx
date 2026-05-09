import { formatPrice, type Product } from '@ecommerce/shared'

export interface ProductCardProps {
  product: Product
  onAddToCart?: (product: Product) => void
}

export function ProductCard({ product, onAddToCart }: ProductCardProps): JSX.Element {
  return (
    <article className="product-card">
      <header>
        <h3>{product.name}</h3>
        <p className="price">{formatPrice(product.priceCents, product.currency)}</p>
      </header>
      <p className="description">{product.description}</p>
      <footer>
        <button
          type="button"
          disabled={!product.inStock}
          onClick={() => onAddToCart?.(product)}
        >
          {product.inStock ? 'Add to cart' : 'Sold out'}
        </button>
      </footer>
    </article>
  )
}
