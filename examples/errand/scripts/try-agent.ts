// End-to-end check of the agent loop, printing every event except screenshots.
// Uses GEMINI_API_KEY from this project's .env.
// Usage: npx tsx scripts/try-agent.ts "first message" "second message" ...
process.env.STEP_DELAY_MS = "0";
const events = await import("../src/events.js");
const res = {
  writeHead() {},
  write(d: string) {
    if (!d.startsWith("data:")) return;
    const e = JSON.parse(d.slice(6));
    if (e.type === "frame" || (e.type === "step" && e.step.status === "running")) return;
    console.log(JSON.stringify(e).slice(0, 400));
  },
  on() {},
};
events.subscribe(res as never);
const agent = await import("../src/agent.js");
const { closeBrowser } = await import("../src/browser.js");
for (const text of process.argv.slice(2)) {
  console.log("\n>>> USER:", text);
  await agent.handleUserMessage(text);
}
await closeBrowser();
process.exit(0);
