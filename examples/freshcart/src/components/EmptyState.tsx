export function EmptyState({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <svg viewBox="0 0 64 64" className="mx-auto h-14 w-14 text-line" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d="M10 22h44l-4 30a4 4 0 0 1-4 3.5H18a4 4 0 0 1-4-3.5z" fill="#fff" />
        <path d="M22 22c0-6 4-11 10-11s10 5 10 11" strokeLinecap="round" />
      </svg>
      <h2 className="mt-4 font-serif text-2xl font-semibold">{title}</h2>
      <p className="mt-2 text-muted">{body}</p>
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
