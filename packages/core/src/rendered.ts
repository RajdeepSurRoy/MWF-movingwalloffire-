import { z } from "zod";

// What a real browser showed of a page, produced outside the engine (@mwf/render) and passed in
// as data so the engine stays pure. It can only add hidden text, never mark static findings clean.
export const RenderedText = z.strictObject({
  text: z.string(),
  // Why the browser did not show it, e.g. "transparent text", "off-page".
  how: z.string(),
  // true: the text is painted invisibly for every visitor (transparent, off-page, tiny, colour
  // equal to background). false: hidden in a way real UIs also use (display:none, clipped by a
  // scroll container, hidden at one screen size only), so it is treated like responsive hiding.
  certain: z.boolean(),
});
export type RenderedText = z.infer<typeof RenderedText>;

export const RenderReport = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    viewports: z.array(z.string()),
    hidden: z.array(RenderedText),
    // Stylesheets the browser requested that the caller did not supply (so were not applied).
    unstyled: z.array(z.string()).default([]),
  }),
  // Render failed, timed out or the page was too large: visibility is unknown.
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
// Input type: `unstyled` may be left out (stored reports from before it existed).
export type RenderReport = z.input<typeof RenderReport>;

// Reports are looked up by the canonical hash of the context item they describe.
export type RenderReports = Record<string, RenderReport>;
