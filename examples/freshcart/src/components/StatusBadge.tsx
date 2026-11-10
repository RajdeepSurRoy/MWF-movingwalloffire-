const STYLES: Record<string, string> = {
  placed: "bg-green-soft text-green",
  preparing: "bg-butter text-ink",
  delivered: "bg-line text-ink",
  cancelled: "bg-tomato/10 text-tomato",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STYLES[status] ?? "bg-line text-ink"}`}>
      {status}
    </span>
  );
}
