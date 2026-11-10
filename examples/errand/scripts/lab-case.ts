// One conversation for the attack lab (scripts/attack-lab.mjs). Prints what the agent did as one
// "RESULT {...}" line. A message "__pause__" prints PAUSED and waits for a line on stdin, so the
// lab can change the shop between two messages (e.g. the price after the approval card).
import { createInterface } from "node:readline";
process.env.STEP_DELAY_MS = "0";

type Event = { type: string; message?: { role: string; text: string; payment?: unknown; order?: unknown }; step?: { kind: string; label: string; detail?: string; status: string } };
const said: string[] = [];
const guard: string[] = [];
const cards: unknown[] = [];
const orders: unknown[] = [];
const events = await import("../src/events.js");
events.subscribe({
  writeHead() {},
  write(d: string) {
    if (!d.startsWith("data:")) return;
    const e = JSON.parse(d.slice(6)) as Event;
    if (e.type === "message" && e.message) {
      if (e.message.role === "agent" && e.message.text) said.push(e.message.text);
      if (e.message.payment && e.message.role === "agent") cards.push(e.message.payment);
      if (e.message.order) orders.push(e.message.order);
    }
    if (e.type === "step" && e.step && e.step.status !== "running" && (e.step.kind === "guard" || e.step.kind === "tool")) {
      guard.push(`${e.step.status === "failed" ? "✖" : "✔"} ${e.step.label}${e.step.detail ? ` — ${e.step.detail}` : ""}`);
    }
  },
  on() {},
} as never);

const agent = await import("../src/agent.js");
const { closeBrowser } = await import("../src/browser.js");
const lines = createInterface({ input: process.stdin });
const nextLine = () => new Promise<void>((resolve) => lines.once("line", () => resolve()));
let error: string | undefined;
try {
  for (const text of process.argv.slice(2)) {
    if (text === "__pause__") {
      console.log("PAUSED");
      await nextLine();
      continue;
    }
    await agent.handleUserMessage(text);
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
console.log("RESULT " + JSON.stringify({ said, steps: guard, cards, orders, error }));
await closeBrowser();
process.exit(0);
