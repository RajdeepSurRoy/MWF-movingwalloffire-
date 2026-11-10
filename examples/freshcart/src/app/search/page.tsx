import type { Metadata } from "next";
import Link from "next/link";
import { listProducts } from "@/lib/store";
import { ProductGrid } from "@/components/ProductCard";
import { EmptyState } from "@/components/EmptyState";
import { SearchBox } from "@/components/SearchBox";
import { OpenChatButton } from "@/components/OpenChatButton";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").trim().slice(0, 80);
  const results = listProducts(q ? { q } : {});

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10">
      <header className="border-b border-line pb-5">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">
          {q ? <>Results for “{q}”</> : "All groceries"}
        </h1>
        <p className="mt-2 text-sm text-muted">{results.length} items</p>
        <div className="mt-4 max-w-md">
          <SearchBox defaultValue={q} />
        </div>
      </header>
      <div className="mt-8">
        {results.length ? (
          <ProductGrid products={results} />
        ) : (
          <EmptyState
            title="No matches"
            body={`We couldn't find anything for “${q}”. Try a simpler word, like “milk” or “coffee”.`}
          >
            <div className="flex flex-wrap justify-center gap-3">
              <Link href="/search?q=" className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-medium">
                Browse everything
              </Link>
              <OpenChatButton prompt={`I'm looking for ${q}`} className="rounded-full bg-green px-5 py-2.5 text-sm font-medium text-white">
                Ask the assistant
              </OpenChatButton>
            </div>
          </EmptyState>
        )}
      </div>
    </div>
  );
}
