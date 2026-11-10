import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCategory, type CategorySlug } from "@/lib/catalog";
import { formatPrice } from "@/lib/pricing";
import { getProduct, listProducts } from "@/lib/store";
import { ProductArt } from "@/components/ProductArt";
import { ProductPurchase } from "@/components/ProductPurchase";
import { ProductCard } from "@/components/ProductCard";

export async function generateMetadata({ params }: PageProps<"/p/[sku]">): Promise<Metadata> {
  const product = getProduct((await params).sku);
  return { title: product?.name ?? "Not found", description: product?.description };
}

export default async function ProductPage({ params }: PageProps<"/p/[sku]">) {
  const product = getProduct((await params).sku);
  if (!product) notFound();
  const category = getCategory(product.category);
  const related = listProducts({ category: product.category as CategorySlug })
    .filter((p) => p.sku !== product.sku)
    .slice(0, 4);
  const lowStock = product.stock > 0 && product.stock <= 10;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/" className="hover:text-ink">Home</Link>
        <span className="mx-2">/</span>
        {category && (
          <Link href={`/c/${category.slug}`} className="hover:text-ink">{category.name}</Link>
        )}
      </nav>

      <div className="mt-6 grid gap-8 md:grid-cols-2 md:gap-14">
        <ProductArt art={product.image} label={product.brand} title={product.name} className="rounded-2xl" />
        <div className="md:pt-6">
          <p className="text-sm uppercase tracking-wide text-muted">{product.brand}</p>
          <h1 className="mt-1 font-serif text-4xl font-semibold leading-tight tracking-tight">{product.name}</h1>
          <p className="mt-1 text-muted">{product.unit}</p>
          <p className="mt-6 text-3xl font-semibold tabular-nums">{formatPrice(product.priceCents)}</p>
          <p className={`mt-1 text-sm ${product.stock === 0 ? "text-tomato" : lowStock ? "text-tomato" : "text-green"}`}>
            {product.stock === 0 ? "Out of stock" : lowStock ? `Only ${product.stock} left` : "In stock"}
          </p>
          <div className="mt-6 max-w-sm">
            <ProductPurchase sku={product.sku} name={product.name} stock={product.stock} />
          </div>
          <div className="mt-8 border-t border-line pt-6">
            <h2 className="text-sm font-medium">About this item</h2>
            {process.env.ATTACK_RAW_HTML === "1" ? (
              <p className="mt-2 leading-relaxed text-muted" dangerouslySetInnerHTML={{ __html: product.description }} />
            ) : (
              <p className="mt-2 leading-relaxed text-muted">{product.description}</p>
            )}
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-muted">Item code</dt>
              <dd className="font-mono text-xs leading-5">{product.sku}</dd>
              <dt className="text-muted">Delivery</dt>
              <dd>Free over $35, otherwise $4.99</dd>
            </dl>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-20" aria-labelledby="related">
          <h2 id="related" className="border-b border-line pb-3 font-serif text-2xl font-semibold">
            More from {category?.name ?? "this aisle"}
          </h2>
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4">
            {related.map((p) => (
              <ProductCard key={p.sku} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
