import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-ink" aria-label="FreshCart home">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
        <circle cx="16" cy="16" r="15" fill="#2f5d3a" />
        <path d="M10 21c0-7 5-11 13-11-1 8-5 12-11 12" fill="#e6eee3" />
        <path d="M10 22c3-4 6-6 9-8" stroke="#2f5d3a" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
      <span className="font-serif text-[1.35rem] font-semibold tracking-tight">FreshCart</span>
    </Link>
  );
}
