export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-10" aria-busy="true" aria-label="Loading">
      <div className="h-9 w-56 animate-pulse rounded-md bg-line" />
      <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i}>
            <div className="aspect-square animate-pulse rounded-xl bg-line/70" />
            <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-line" />
            <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
