import { asc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { dishIngredients, dishes, ingredients } from "@/db/schema";

export const runtime = "nodejs";

type DishRow = {
  id: number;
  title: string;
  rawLine: string;
  sourceMessageId: string;
  imageUrlsJson: string;
};

async function attachIngredients(
  db: ReturnType<typeof getDb>,
  rows: DishRow[],
) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const links = await db
    .select({
      dishId: dishIngredients.dishId,
      name: ingredients.name,
    })
    .from(dishIngredients)
    .innerJoin(ingredients, eq(dishIngredients.ingredientId, ingredients.id))
    .where(inArray(dishIngredients.dishId, ids));

  const byDish = new Map<number, string[]>();
  for (const l of links) {
    const list = byDish.get(l.dishId) ?? [];
    list.push(l.name);
    byDish.set(l.dishId, list);
  }

  return rows.map((r) => ({
    ...r,
    imageUrls: JSON.parse(r.imageUrlsJson || "[]") as string[],
    ingredients: byDish.get(r.id) ?? [],
  }));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.getAll("ingredient");
  const match = searchParams.get("match") === "any" ? "any" : "all";
  const names = [...new Set(raw.map((s) => s.toLowerCase().trim()).filter(Boolean))];

  const db = getDb();

  if (names.length === 0) {
    const rows = await db
      .select({
        id: dishes.id,
        title: dishes.title,
        rawLine: dishes.rawLine,
        sourceMessageId: dishes.sourceMessageId,
        imageUrlsJson: dishes.imageUrlsJson,
      })
      .from(dishes)
      .orderBy(asc(dishes.sortIndex), asc(dishes.id));

    const withIngs = await attachIngredients(db, rows);
    return NextResponse.json({ dishes: withIngs });
  }

  const ingRows = await db
    .select({ id: ingredients.id, name: ingredients.name })
    .from(ingredients)
    .where(inArray(ingredients.name, names));

  if (ingRows.length === 0) {
    return NextResponse.json({ dishes: [] });
  }

  const ingIds = ingRows.map((r) => r.id);

  if (match === "all" && ingRows.length !== names.length) {
    return NextResponse.json({
      dishes: [],
      warning:
        "Some ingredients are not in the database yet (sync menus first or check spelling).",
    });
  }

  const links = await db
    .select({
      dishId: dishIngredients.dishId,
      ingredientId: dishIngredients.ingredientId,
    })
    .from(dishIngredients)
    .where(inArray(dishIngredients.ingredientId, ingIds));

  const dishToMatched = new Map<number, Set<number>>();
  for (const l of links) {
    if (!dishToMatched.has(l.dishId)) {
      dishToMatched.set(l.dishId, new Set());
    }
    dishToMatched.get(l.dishId)!.add(l.ingredientId);
  }

  let dishIds: number[];
  if (match === "any") {
    dishIds = [...dishToMatched.keys()];
  } else {
    dishIds = [...dishToMatched.entries()]
      .filter(([, set]) => set.size === ingIds.length)
      .map(([id]) => id);
  }

  if (dishIds.length === 0) {
    return NextResponse.json({ dishes: [] });
  }

  const rows = await db
    .select({
      id: dishes.id,
      title: dishes.title,
      rawLine: dishes.rawLine,
      sourceMessageId: dishes.sourceMessageId,
      imageUrlsJson: dishes.imageUrlsJson,
    })
    .from(dishes)
    .where(inArray(dishes.id, dishIds))
    .orderBy(asc(dishes.sortIndex), asc(dishes.id));

  const withIngs = await attachIngredients(db, rows);
  return NextResponse.json({ dishes: withIngs });
}
