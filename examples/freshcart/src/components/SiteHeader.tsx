import Link from "next/link";
import { CATEGORIES } from "@/lib/catalog";
import { readSessionId } from "@/lib/session";
import { getCart } from "@/lib/store";
import { Logo } from "./Logo";
import { SearchBox } from "./SearchBox";

export async function SiteHeader() {
  const cart = getCart(await readSessionId());
  const count = cart.totals.itemCount;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur">
      <div className="bg-green text-center text-[13px] text-green-soft">
        <p className="mx-auto max-w-6xl px-4 py-1.5">
          Free delivery on orders over $35 · Demo store — no real payments
        </p>
      </div>
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:gap-6">
        <Logo />
        <div className="hidden flex-1 sm:block">
          <SearchBox />
        </div>
        <nav className="ml-auto flex items-center gap-1 text-sm sm:ml-0">
          <Link href="/orders" className="rounded-md px-3 py-2 text-muted hover:text-ink">
            Orders
          </Link>
          <Link
            href="/cart"
            className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 font-medium hover:border-ink/30"
          >
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="9.5" cy="19.5" r="1.3" />
              <circle cx="17" cy="19.5" r="1.3" />
            </svg>
            <span>Cart</span>
            <span
              className={`min-w-5 rounded-full px-1.5 text-center text-xs leading-5 ${count ? "bg-green text-white" : "bg-line text-muted"}`}
              aria-label={`${count} items in cart`}
            >
              {count}
            </span>
          </Link>
        </nav>
      </div>
      <div className="px-4 pb-3 sm:hidden">
        <SearchBox />
      </div>
      <nav aria-label="Categories" className="no-scrollbar mx-auto max-w-6xl overflow-x-auto px-4">
        <ul className="flex gap-5 whitespace-nowrap pb-2.5 text-sm text-muted">
          {CATEGORIES.map((c) => (
            <li key={c.slug}>
              <Link href={`/c/${c.slug}`} className="hover:text-ink">
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
