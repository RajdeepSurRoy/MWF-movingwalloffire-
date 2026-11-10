/** Hides the [[SKU]] tags the assistant uses to attach product cards. */
export function stripMarkers(text: string) {
  return text
    .replace(/\s*\[\[[A-Za-z0-9-]{3,40}\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
