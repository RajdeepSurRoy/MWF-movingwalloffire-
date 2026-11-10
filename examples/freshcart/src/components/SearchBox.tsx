import Form from "next/form";

export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <Form action="/search" role="search" className="relative w-full max-w-md">
      <label htmlFor="site-search" className="sr-only">
        Search groceries
      </label>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" strokeLinecap="round" />
      </svg>
      <input
        id="site-search"
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="Search apples, coffee, batteries…"
        maxLength={80}
        className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-4 text-sm placeholder:text-muted/80 focus:border-green focus:outline-none"
      />
    </Form>
  );
}
