export const CATEGORIES = [
  { slug: "produce", name: "Produce", blurb: "Fruit and vegetables, picked at peak." },
  { slug: "dairy", name: "Dairy & Eggs", blurb: "Milk, cheese, yogurt, and the morning basics." },
  { slug: "bakery", name: "Bakery", blurb: "Bread and pastries, baked daily." },
  { slug: "pantry", name: "Pantry", blurb: "Pasta, grains, sauces, and staples." },
  { slug: "snacks", name: "Snacks", blurb: "Something crunchy, something sweet." },
  { slug: "beverages", name: "Beverages", blurb: "Coffee, tea, juice, and sparkling water." },
  { slug: "household", name: "Household", blurb: "Cleaning, paper goods, and batteries." },
  { slug: "personal-care", name: "Personal Care", blurb: "Gentle everyday care." },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];

export function getCategory(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

export const DELIVERY_SLOTS = [
  "Today, 5–7 pm",
  "Today, 7–9 pm",
  "Tomorrow, 9–11 am",
  "Tomorrow, 12–2 pm",
  "Tomorrow, 5–7 pm",
] as const;

export const MAX_QTY_PER_ITEM = 20;
