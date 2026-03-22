import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { ingredients } from "@/db/schema";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.toLowerCase().trim() ?? "";

  const db = getDb();
  const rows = await db
    .select({ name: ingredients.name })
    .from(ingredients)
    .orderBy(asc(ingredients.name));

  const filtered = q
    ? rows.filter((r) => r.name.includes(q))
    : rows;

  return NextResponse.json({
    ingredients: filtered.map((r) => r.name),
  });
}
