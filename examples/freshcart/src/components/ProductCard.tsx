import Link from "next/link";
import type { Product } from "@/lib/db/schema";
import { formatPrice } from "@/lib/pricing";
import { ProductArt } from "./ProductArt";
import { AddToCartButton } from "./AddToCartButton";

export function ProductCard({ product }: { product: Product }) {
  const soldOut = product.stock === 0;
  return (
    <article className="group flex flex-col">
      <Link href={`/p/${product.sku}`} className="block overflow-hidden rounded-xl">
        <ProductArt
          art={product.image}
          label={product.brand}
          title={product.name}
          className="transition-transform duration-300 group-hover:scale-[1.02]"
        />
      </Link>
      <div className="mt-3 flex flex-1 flex-col">
        <p className="text-xs uppercase tracking-wide text-muted">{product.brand}</p>
        <Link href={`/p/${product.sku}`} className="mt-0.5 font-medium leading-snug hover:underline">
          {product.name}
        </Link>
        <p className="mt-0.5 text-sm text-muted">{product.unit}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          <span className="font-semibold tabular-nums">{formatPrice(product.priceCents)}</span>
          <AddToCartButton sku={product.sku} name={product.name} disabled={soldOut} compact />
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ products }: { products: Product[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <ProductCard key={p.sku} product={p} />
      ))}
    </div>
  );
}
