import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCategory } from "@/lib/catalog";
import { listProducts } from "@/lib/store";
import { ProductGrid } from "@/components/ProductCard";
import { EmptyState } from "@/components/EmptyState";

export async function generateMetadata({ params }: PageProps<"/c/[category]">): Promise<Metadata> {
  const category = getCategory((await params).category);
  return { title: category?.name ?? "Not found" };
}

export default async function CategoryPage({ params }: PageProps<"/c/[category]">) {
  const category = getCategory((await params).category);
  if (!category) notFound();
  const items = listProducts({ category: category.slug });

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10">
      <header className="border-b border-line pb-5">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{category.name}</h1>
        <p className="mt-2 text-muted">{category.blurb}</p>
        <p className="mt-1 text-sm text-muted">{items.length} items</p>
      </header>
      <div className="mt-8">
        {items.length ? (
          <ProductGrid products={items} />
        ) : (
          <EmptyState title="Nothing on the shelf yet" body="This aisle is being restocked. Check back soon." />
        )}
      </div>
    </div>
  );
}
