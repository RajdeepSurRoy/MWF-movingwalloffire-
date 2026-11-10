"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="font-serif text-3xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-muted">We couldn&apos;t load this page. It&apos;s us, not you.</p>
      <button type="button" onClick={() => retry()} className="mt-6 rounded-full bg-green px-6 py-3 font-medium text-white">
        Try again
      </button>
    </div>
  );
}
