import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DELIVERY_SLOTS } from "./store.js";

/**
 * What the agent knows about the person it shops for: where to deliver,
 * when, what they like, and how much one order may cost. Saved to
 * data/profile.json and editable from the UI.
 */
export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email(),
  address: z.string().trim().min(8).max(200),
  deliverySlot: z.enum(DELIVERY_SLOTS),
  preferences: z.string().trim().max(400),
  budgetPerOrder: z.number().min(1).max(10_000),
});
export type Profile = z.infer<typeof profileSchema>;

const FILE = "data/profile.json";

const DEFAULT_PROFILE: Profile = {
  name: "Alex Rivera",
  email: "alex@example.com",
  address: "42 Commit Lane, Apt 7, Springfield",
  deliverySlot: "Today, 7–9 pm",
  preferences: "Vegetarian. Likes spicy food. Prefers quick meals on work nights.",
  budgetPerOrder: 60,
};

export function getProfile(): Profile {
  try {
    if (existsSync(FILE)) return profileSchema.parse(JSON.parse(readFileSync(FILE, "utf8")));
  } catch {
    // A broken file falls back to the default profile.
  }
  return DEFAULT_PROFILE;
}

export function saveProfile(input: unknown): Profile {
  const profile = profileSchema.parse(input);
  mkdirSync("data", { recursive: true });
  writeFileSync(FILE, JSON.stringify(profile, null, 2));
  return profile;
}
