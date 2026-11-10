import { openDatabase, resetDatabase, databasePath } from "../src/lib/db";

const file = databasePath();
const db = openDatabase(file);
resetDatabase(db);
const { n } = db.$client.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number };
console.log(`FreshCart database reset at ${file}: ${n} products, no carts, no orders.`);
db.$client.close();
