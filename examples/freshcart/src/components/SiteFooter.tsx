import Link from "next/link";
import { CATEGORIES } from "@/lib/catalog";

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-3">
        <div>
          <p className="font-serif text-lg font-semibold">FreshCart</p>
          <p className="mt-2 max-w-xs text-muted">
            A fictional neighborhood grocer, built as a demo. Every brand here is invented and no
            real payments are taken.
          </p>
        </div>
        <div>
          <p className="font-medium">Shop</p>
          <ul className="mt-2 grid grid-cols-2 gap-1.5 text-muted">
            {CATEGORIES.map((c) => (
              <li key={c.slug}>
                <Link href={`/c/${c.slug}`} className="hover:text-ink">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Your account</p>
          <ul className="mt-2 space-y-1.5 text-muted">
            <li><Link href="/cart" className="hover:text-ink">Cart</Link></li>
            <li><Link href="/orders" className="hover:text-ink">Order history</Link></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
