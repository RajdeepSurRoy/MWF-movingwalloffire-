import { type Channel, extractSegments } from "./html.js";
import { type RuleBundle, type Severity, regex } from "./rules.js";
import type { ContextItem } from "./schemas.js";

export interface Finding {
  rule_id: string;
  severity: Exclude<Severity, "none">;
  item_id: string;
  channel: Channel | "text";
  excerpt: string;
}

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const ZERO_WIDTH_IN_WORD = /\p{L}[​‌⁠﻿]+\p{L}/u;

// NFKC folds full-width and compatibility characters; spaces collapse but newlines stay,
// so `^` in a rule means "start of a text segment".
function normalize(text: string, stripZeroWidth: boolean): string {
  let t = text.normalize("NFKC");
  if (stripZeroWidth) t = t.replace(ZERO_WIDTH, "");
  return t.replace(/[^\S\n]+/g, " ").toLowerCase();
}

const excerptOf = (text: string, index: number) =>
  text.slice(Math.max(0, index - 10), index + 70).replace(/\s+/g, " ").trim();

function matchRules(bundle: RuleBundle, raw: string, channel: Channel | "text", itemId: string): Finding[] {
  const findings: Finding[] = [];
  const clean = normalize(raw, true);
  const unstripped = normalize(raw, false);
  for (const rule of bundle.text_rules) {
    const severity = channel === "visible" || channel === "text" ? rule.visible : rule.hidden;
    for (const p of rule.patterns) {
      const re = regex(bundle, p, "imu");
      const m = re.exec(clean);
      if (!m) continue;
      // Matches only once zero-width characters are removed: the text was disguised on purpose.
      if (!re.test(unstripped)) {
        findings.push({ rule_id: "CTX.OBFUSCATED_INSTRUCTION", severity: "hard", item_id: itemId, channel, excerpt: excerptOf(clean, m.index) });
      }
      if (severity !== "none") findings.push({ rule_id: rule.id, severity, item_id: itemId, channel, excerpt: excerptOf(clean, m.index) });
      break;
    }
  }
  return findings;
}

// Scans one context item for injection artifacts. Pure and deterministic.
export function scanContextItem(item: ContextItem, bundle: RuleBundle): Finding[] {
  if (item.trust === "trusted") return [];
  const findings: Finding[] = [];
  const push = (f: Finding) => {
    if (!findings.some((x) => x.rule_id === f.rule_id && x.channel === f.channel)) findings.push(f);
  };

  if (ZERO_WIDTH_IN_WORD.test(item.content)) {
    push({ rule_id: "CTX.ZERO_WIDTH", severity: "soft", item_id: item.id, channel: "text", excerpt: "zero-width characters inside words" });
  }

  if (item.content_type !== "text/html") {
    for (const f of matchRules(bundle, item.content, "text", item.id)) push(f);
    return findings;
  }

  const segments = extractSegments(item.content);
  const byChannel = new Map<Channel, string[]>();
  for (const s of segments) byChannel.set(s.channel, [...(byChannel.get(s.channel) ?? []), s.text]);

  const hidden = segments.filter((s) => s.channel === "hidden");
  if (hidden.length > 0) {
    // Hidden text alone is common on real sites (menus, screen-reader text): a weak signal.
    push({ rule_id: "CTX.HIDDEN_TEXT", severity: "info", item_id: item.id, channel: "hidden", excerpt: `${hidden[0]!.how}: ${hidden[0]!.text.trim().slice(0, 60)}` });
  }
  for (const [channel, texts] of byChannel) {
    for (const f of matchRules(bundle, texts.join("\n"), channel, item.id)) push(f);
  }
  return findings;
}

export function scanContext(items: ContextItem[], bundle: RuleBundle): Finding[] {
  return items.flatMap((i) => scanContextItem(i, bundle));
}

// Scans free text (a user prompt, an agent output) as if a human could see all of it.
export function scanText(text: string, id: string, bundle: RuleBundle): Finding[] {
  return matchRules(bundle, text, "text", id);
}
