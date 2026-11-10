import Link from "next/link";
import { CATEGORIES } from "@/lib/catalog";
import { getProduct, listFeatured } from "@/lib/store";
import { ProductArt } from "@/components/ProductArt";
import { ProductGrid } from "@/components/ProductCard";
import { OpenChatButton } from "@/components/OpenChatButton";

const CATEGORY_COVER: Record<string, string> = {
  produce: "PRD-APPLE-2LB",
  dairy: "DRY-MILK-WHL-GAL",
  bakery: "BKY-SOUR-LOAF",
  pantry: "PNT-OLIVE-500",
  snacks: "SNK-CHIPS-SEA",
  beverages: "BEV-SPARK-LIME-8",
  household: "HSE-TOWEL-6",
  "personal-care": "PRC-SHAMP-12",
};

const HERO_SKUS = ["BKY-SOUR-LOAF", "PRD-AVO-4CT", "BEV-COLDBREW-32"];

const PROMPTS = [
  "Stock me up for a pasta night for four",
  "What's good for a quick breakfast?",
  "Add two cartons of whole milk",
];

export default function HomePage() {
  const featured = listFeatured();
  const hero = HERO_SKUS.map((sku) => getProduct(sku)).filter((p) => p !== undefined);

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-10 md:grid-cols-[1.1fr_1fr] md:pt-16">
        <div>
          <p className="text-sm font-medium text-green">Delivered today, from 5 pm</p>
          <h1 className="mt-3 font-serif text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Groceries for the week, sorted.
          </h1>
          <p className="mt-5 max-w-md text-lg text-muted">
            Fresh produce, good bread and the everyday basics. Browse the aisles yourself, or tell
            our assistant what you need and it fills the cart for you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/c/produce" className="rounded-full bg-green px-6 py-3 font-medium text-white hover:bg-green-dark">
              Start shopping
            </Link>
            <OpenChatButton className="rounded-full border border-ink/20 bg-surface px-6 py-3 font-medium hover:border-ink/50">
              Ask the assistant
            </OpenChatButton>
          </div>
        </div>
        <div className="relative mx-auto grid w-full max-w-md grid-cols-2 gap-4">
          {hero[0] && (
            <Link href={`/p/${hero[0].sku}`} className="col-span-2 overflow-hidden rounded-2xl">
              <ProductArt art={hero[0].image} label={hero[0].brand} title={hero[0].name} className="aspect-[2/1]!" />
            </Link>
          )}
          {hero.slice(1).map((p) => (
            <Link key={p.sku} href={`/p/${p.sku}`} className="overflow-hidden rounded-2xl">
              <ProductArt art={p.image} label={p.brand} title={p.name} />
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4" aria-labelledby="aisles">
        <div className="flex items-end justify-between border-b border-line pb-3">
          <h2 id="aisles" className="font-serif text-2xl font-semibold">Shop the aisles</h2>
        </div>
        <ul className="mt-6 grid grid-cols-4 gap-x-4 gap-y-6 sm:grid-cols-8">
          {CATEGORIES.map((c) => {
            const cover = getProduct(CATEGORY_COVER[c.slug]);
            return (
              <li key={c.slug}>
                <Link href={`/c/${c.slug}`} className="group block text-center">
                  {cover && (
                    <ProductArt art={cover.image} label={cover.brand} title={c.name} className="rounded-full transition-transform group-hover:-translate-y-0.5" />
                  )}
                  <span className="mt-2 block text-sm leading-tight">{c.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-4" aria-labelledby="featured">
        <div className="flex items-end justify-between border-b border-line pb-3">
          <h2 id="featured" className="font-serif text-2xl font-semibold">This week&apos;s picks</h2>
          <Link href="/search?q=" className="text-sm text-muted hover:text-ink">See everything →</Link>
        </div>
        <div className="mt-6">
          <ProductGrid products={featured} />
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-6xl px-4">
        <div className="grid gap-8 rounded-2xl bg-green px-6 py-10 text-green-soft sm:px-10 md:grid-cols-[1fr_1.2fr] md:items-center">
          <div>
            <h2 className="font-serif text-3xl font-semibold text-white">Shop by just asking.</h2>
            <p className="mt-3 max-w-sm">
              The FreshCart assistant knows the whole store. It can find items, build your cart, and
              place the order once you say so.
            </p>
          </div>
          <ul className="flex flex-col gap-2.5">
            {PROMPTS.map((prompt) => (
              <li key={prompt}>
                <OpenChatButton
                  prompt={prompt}
                  className="w-full rounded-xl border border-white/20 px-4 py-3 text-left text-white transition-colors hover:bg-white/10"
                >
                  “{prompt}”
                </OpenChatButton>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
