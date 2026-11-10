import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-sm font-medium text-green">404</p>
      <h1 className="mt-2 font-serif text-3xl font-semibold">We couldn&apos;t find that</h1>
      <p className="mt-2 text-muted">The page or product may have moved, or never existed.</p>
      <Link href="/" className="mt-6 inline-block rounded-full bg-green px-6 py-3 font-medium text-white">
        Back to the store
      </Link>
    </div>
  );
}
