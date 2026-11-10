"use client";

export const OPEN_CHAT_EVENT = "freshcart:open-chat";

export function OpenChatButton({ children, prompt, className }: { children: React.ReactNode; prompt?: string; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { prompt } }))}
    >
      {children}
    </button>
  );
}
