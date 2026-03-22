import { desc, eq, max } from "drizzle-orm";
import { getDb } from "@/db";
import {
  dishPhotoLinks,
  dishIngredients,
  dishes,
  ingredients,
  messagesRaw,
  syncState,
} from "@/db/schema";
import {
  fetchMessages,
  messageImageUrls,
  type GroupMeMessage,
} from "@/lib/groupme";
import {
  dishTitleFromLine,
  classifyOcrMenuStrict,
  normalizeIngredientToken,
  splitIntoDishLines,
  tokenizeIngredientsFromLine,
} from "@/lib/parser";
import { analyzeMessageImages, isVisionConfigured, type VisionImageAnalysis, type VisionMessageAnalysis } from "@/lib/vision";

const OCR_PROVIDER = "openai_responses_vision";

/** If set (e.g. `20`), backfill stops after that many messages (newest first). Omit for full history. */
function readBackfillMax(): number | undefined {
  const v = process.env.BACKFILL_MAX_MESSAGES?.trim();
  if (!v) return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function maxMessageId(a: string, b: string): string {
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return a > b ? a : b;
  }
}

type ExistingMessageRow = {
  ocrText: string | null;
  ocrProvider: string | null;
  visionKind: string | null;
  visionJson: string | null;
};

type FreshVision = {
  analysis: VisionMessageAnalysis | null;
  ocrText: string | null;
  ocrProvider: string | null;
  ocrAt: Date | null;
  visionKind: string | null;
  visionJson: string | null;
};

function summarizeVisionKind(items: VisionImageAnalysis[]): string | null {
  if (items.some((i) => i.kind === "menu")) return "menu";
  if (items.some((i) => i.kind === "meal")) return "meal";
  if (items.some((i) => i.kind === "other")) return "other";
  if (items.some((i) => i.kind === "uncertain")) return "uncertain";
  return null;
}

function collectMenuText(analysis: VisionMessageAnalysis): string | null {
  const chunks = analysis.items
    .filter((i) => i.kind === "menu")
    .map((i) => i.menuText.trim())
    .filter(Boolean);
  return chunks.join("\n\n").trim() || null;
}

async function listRecentDishTitles(limit: number): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ title: dishes.title })
    .from(dishes)
    .orderBy(desc(dishes.id))
    .limit(limit);
  const unique = new Set<string>();
  for (const row of rows) {
    const t = row.title.trim();
    if (t) unique.add(t);
  }
  return [...unique];
}

/** New OpenAI vision analysis from this run only; `null` if skipped or failed. */
async function runVisionIfNeeded(
  msg: GroupMeMessage,
  existing: ExistingMessageRow,
): Promise<FreshVision> {
  if (existing.visionJson?.trim()) {
    return {
      analysis: null,
      ocrText: null,
      ocrProvider: null,
      ocrAt: null,
      visionKind: null,
      visionJson: null,
    };
  }
  const urls = messageImageUrls(msg);
  if (urls.length === 0) {
    return {
      analysis: null,
      ocrText: null,
      ocrProvider: null,
      ocrAt: null,
      visionKind: null,
      visionJson: null,
    };
  }
  if (!isVisionConfigured() || process.env.SKIP_VISION === "1") {
    return {
      analysis: null,
      ocrText: null,
      ocrProvider: null,
      ocrAt: null,
      visionKind: null,
      visionJson: null,
    };
  }
  const knownTitles = await listRecentDishTitles(120);
  const analysis = await analyzeMessageImages(urls, msg.text ?? "", knownTitles);
  if (!analysis) {
    return {
      analysis: null,
      ocrText: null,
      ocrProvider: null,
      ocrAt: null,
      visionKind: null,
      visionJson: null,
    };
  }
  const mergedMenuText = collectMenuText(analysis);
  const now = new Date();
  return {
    analysis,
    ocrText: mergedMenuText,
    ocrProvider: OCR_PROVIDER,
    ocrAt: now,
    visionKind: summarizeVisionKind(analysis.items),
    visionJson: JSON.stringify(analysis),
  };
}

async function upsertMessageRow(
  msg: GroupMeMessage,
  existing: ExistingMessageRow,
  fresh: FreshVision,
) {
  const db = getDb();
  const finalOcr = fresh.ocrText ?? existing.ocrText ?? null;
  const finalVisionKind = fresh.visionKind ?? existing.visionKind ?? null;
  const finalVisionJson = fresh.visionJson ?? existing.visionJson ?? null;
  const finalProvider = finalOcr
    ? (fresh.ocrProvider ?? existing.ocrProvider ?? OCR_PROVIDER)
    : null;
  const finalOcrAt = finalOcr ? (fresh.ocrAt ?? new Date()) : null;

  await db
    .insert(messagesRaw)
    .values({
      id: msg.id,
      groupId: msg.group_id,
      createdAt: new Date(msg.created_at * 1000),
      text: msg.text ?? "",
      attachmentsJson: JSON.stringify(msg.attachments ?? []),
      ocrText: finalOcr,
      ocrProvider: finalProvider,
      ocrAt: finalOcrAt,
      visionKind: finalVisionKind,
      visionJson: finalVisionJson,
      userId: msg.user_id,
      userName: msg.name,
    })
    .onConflictDoUpdate({
      target: messagesRaw.id,
      set: fresh.ocrText
        ? {
            text: msg.text ?? "",
            attachmentsJson: JSON.stringify(msg.attachments ?? []),
            userName: msg.name,
            ocrText: finalOcr,
            ocrProvider: finalProvider,
            ocrAt: finalOcrAt,
            visionKind: finalVisionKind,
            visionJson: finalVisionJson,
          }
        : {
            text: msg.text ?? "",
            attachmentsJson: JSON.stringify(msg.attachments ?? []),
            userName: msg.name,
            ocrText: finalOcr,
            ocrProvider: finalProvider,
            ocrAt: finalOcrAt,
            visionKind: finalVisionKind,
            visionJson: finalVisionJson,
          },
    });
}

function parseVisionJson(raw: string | null): VisionMessageAnalysis | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as VisionMessageAnalysis;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  const parts = normalizeTitle(text)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  return new Set(parts);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap++;
  }
  return overlap / Math.max(a.size, b.size);
}

type CandidateDish = {
  id: number;
  title: string;
  norm: string;
  tokens: Set<string>;
};

async function loadCandidateDishes(limit = 220): Promise<CandidateDish[]> {
  const db = getDb();
  const rows = await db
    .select({ id: dishes.id, title: dishes.title })
    .from(dishes)
    .orderBy(desc(dishes.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    norm: normalizeTitle(r.title),
    tokens: tokenSet(r.title),
  }));
}

function chooseDishForMeal(
  item: VisionImageAnalysis,
  caption: string,
  candidates: CandidateDish[],
): CandidateDish | null {
  const byNorm = new Map<string, CandidateDish>();
  for (const c of candidates) {
    if (!byNorm.has(c.norm)) byNorm.set(c.norm, c);
  }

  const menuMatch = normalizeTitle(item.matchedMenuTitle);
  if (menuMatch) {
    const exact = byNorm.get(menuMatch);
    if (exact) return exact;
  }

  const guessMatch = normalizeTitle(item.mealNameGuess);
  if (guessMatch) {
    const exact = byNorm.get(guessMatch);
    if (exact) return exact;
  }

  const probe = tokenSet(`${item.mealNameGuess} ${caption}`);
  let best: CandidateDish | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = overlapScore(probe, c.tokens);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best && bestScore >= 0.72 && item.confidence >= 55) {
    return best;
  }
  return null;
}

function extractMenuLinesFromVision(
  vision: VisionMessageAnalysis,
): { lines: string[]; menuImageUrls: string[] } {
  const menuItems: string[] = [];
  const menuImageUrls: string[] = [];
  const menuTexts: string[] = [];
  for (const item of vision.items) {
    if (item.kind !== "menu") continue;
    menuImageUrls.push(item.imageUrl);
    for (const line of item.menuItems) {
      const trimmed = line.trim();
      if (trimmed) menuItems.push(trimmed);
    }
    if (item.menuText.trim()) menuTexts.push(item.menuText.trim());
  }

  let lines = [...new Set(menuItems)];
  if (lines.length === 0 && menuTexts.length > 0) {
    lines = splitIntoDishLines(menuTexts.join("\n\n"));
  }
  return { lines, menuImageUrls: [...new Set(menuImageUrls)] };
}

async function upsertDishPhotoLinksForMessage(
  msg: GroupMeMessage,
  vision: VisionMessageAnalysis,
) {
  const db = getDb();
  const meals = vision.items.filter((i) => i.kind === "meal");
  if (meals.length === 0) return;

  const candidates = await loadCandidateDishes();
  if (candidates.length === 0) return;

  for (const meal of meals) {
    const selected = chooseDishForMeal(meal, msg.text ?? "", candidates);
    if (!selected) continue;
    await db
      .insert(dishPhotoLinks)
      .values({
        dishId: selected.id,
        sourceMessageId: msg.id,
        imageUrl: meal.imageUrl,
        caption: msg.text ?? "",
        matchedTitle: meal.matchedMenuTitle || meal.mealNameGuess || selected.title,
        confidence: meal.confidence,
        matchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          dishPhotoLinks.dishId,
          dishPhotoLinks.sourceMessageId,
          dishPhotoLinks.imageUrl,
        ],
        set: {
          caption: msg.text ?? "",
          matchedTitle: meal.matchedMenuTitle || meal.mealNameGuess || selected.title,
          confidence: meal.confidence,
          matchedAt: new Date(),
        },
      });
  }
}

async function reparseDishesForMessage(
  msg: GroupMeMessage,
  vision: VisionMessageAnalysis | null,
  fallbackOcrText: string | null,
) {
  const db = getDb();
  const imageUrls = messageImageUrls(msg);
  // Image-only extraction: skip all text-only messages.
  if (imageUrls.length === 0) {
    await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
    await db.delete(dishPhotoLinks).where(eq(dishPhotoLinks.sourceMessageId, msg.id));
    return;
  }

  if (!vision && !(fallbackOcrText ?? "").trim()) {
    // No analysis available yet; keep any existing parse results intact.
    return;
  }

  let lines: string[] = [];
  let menuImageUrls = imageUrls;
  let shouldRebuildMenuRows = false;

  if (vision) {
    const extracted = extractMenuLinesFromVision(vision);
    lines = extracted.lines;
    menuImageUrls = extracted.menuImageUrls.length > 0 ? extracted.menuImageUrls : imageUrls;
    shouldRebuildMenuRows = lines.length > 0;
  } else {
    const menu = classifyOcrMenuStrict(fallbackOcrText);
    if (menu.isMenu) {
      lines = splitIntoDishLines((fallbackOcrText ?? "").trim());
      shouldRebuildMenuRows = lines.length > 0;
    } else {
      await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
      return;
    }
  }

  if (shouldRebuildMenuRows) {
    await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
  } else if (vision) {
    // If we confidently analyzed the message but found no menu content, clear menu rows for this message.
    await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
  }

  if (shouldRebuildMenuRows) {
    let sortIndex = 0;
    for (const line of lines) {
      const title = dishTitleFromLine(line);
      const tokens = tokenizeIngredientsFromLine(line);
      const normalized = [
        ...new Set(
          tokens.map(normalizeIngredientToken).filter((t) => t.length >= 2),
        ),
      ];
      if (normalized.length === 0 && title.length < 4) continue;

      const [dishRow] = await db
        .insert(dishes)
        .values({
          sourceMessageId: msg.id,
          title,
          rawLine: line,
          sortIndex: sortIndex++,
          imageUrlsJson: JSON.stringify(menuImageUrls),
        })
        .returning({ id: dishes.id });

      if (!dishRow) continue;

      for (const ingName of normalized) {
        await db
          .insert(ingredients)
          .values({ name: ingName })
          .onConflictDoNothing({ target: ingredients.name });
        const [ing] = await db
          .select({ id: ingredients.id })
          .from(ingredients)
          .where(eq(ingredients.name, ingName))
          .limit(1);
        if (!ing) continue;
        await db
          .insert(dishIngredients)
          .values({ dishId: dishRow.id, ingredientId: ing.id })
          .onConflictDoNothing();
      }
    }
  }

  if (vision) {
    await db.delete(dishPhotoLinks).where(eq(dishPhotoLinks.sourceMessageId, msg.id));
    await upsertDishPhotoLinksForMessage(msg, vision);
  }
}

export async function ingestMessage(
  _token: string,
  msg: GroupMeMessage,
  existing: ExistingMessageRow,
) {
  const fresh = await runVisionIfNeeded(msg, existing);
  await upsertMessageRow(msg, existing, fresh);
  const finalVision = fresh.analysis ?? parseVisionJson(existing.visionJson);
  const finalOcr = fresh.ocrText ?? existing.ocrText ?? null;
  await reparseDishesForMessage(msg, finalVision, finalOcr);
}

export type SyncResult = {
  mode: string;
  messagesProcessed: number;
  lastAfterId: string | null;
  backfillComplete: boolean;
  /** True when stopped early because of `BACKFILL_MAX_MESSAGES`. */
  truncated?: boolean;
  backfillMax?: number;
};

export async function runIncrementalSync(
  token: string,
  groupId: string,
): Promise<SyncResult> {
  const db = getDb();
  const state = await db
    .select()
    .from(syncState)
    .where(eq(syncState.groupId, groupId))
    .limit(1);
  let afterId =
    state[0]?.lastAfterId ??
    (
      await db
        .select({ m: max(messagesRaw.id) })
        .from(messagesRaw)
        .where(eq(messagesRaw.groupId, groupId))
    )[0]?.m ??
    undefined;
  let processed = 0;

  for (;;) {
    const { messages } = await fetchMessages(token, groupId, {
      limit: 100,
      after_id: afterId,
    });
    if (messages.length === 0) break;
    for (const msg of messages) {
      const existing = await db
        .select({
          ocrText: messagesRaw.ocrText,
          ocrProvider: messagesRaw.ocrProvider,
          visionKind: messagesRaw.visionKind,
          visionJson: messagesRaw.visionJson,
        })
        .from(messagesRaw)
        .where(eq(messagesRaw.id, msg.id))
        .limit(1);
      await ingestMessage(token, msg, {
        ocrText: existing[0]?.ocrText ?? null,
        ocrProvider: existing[0]?.ocrProvider ?? null,
        visionKind: existing[0]?.visionKind ?? null,
        visionJson: existing[0]?.visionJson ?? null,
      });
      processed++;
      afterId = afterId ? maxMessageId(afterId, msg.id) : msg.id;
    }
    await sleep(350);
  }

  await db
    .insert(syncState)
    .values({
      groupId,
      lastAfterId: afterId ?? null,
      backfillComplete: state[0]?.backfillComplete ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: syncState.groupId,
      set: {
        lastAfterId: afterId ?? null,
        updatedAt: new Date(),
      },
    });

  return {
    mode: "incremental",
    messagesProcessed: processed,
    lastAfterId: afterId ?? null,
    backfillComplete: state[0]?.backfillComplete ?? false,
  };
}

export async function runBackfillSync(
  token: string,
  groupId: string,
): Promise<SyncResult> {
  const db = getDb();
  const cap = readBackfillMax();
  let beforeId: string | undefined;
  let processed = 0;
  let maxSeen: string | null = null;
  let truncatedByCap = false;

  for (;;) {
    if (cap !== undefined && processed >= cap) {
      truncatedByCap = true;
      break;
    }

    const remaining =
      cap !== undefined ? Math.max(cap - processed, 1) : 100;
    const pageLimit = cap !== undefined ? Math.min(100, remaining) : 100;

    const { messages } = await fetchMessages(token, groupId, {
      limit: pageLimit,
      before_id: beforeId,
    });
    if (messages.length === 0) break;

    /** Newest-first page order; last processed id is the `before_id` cursor for the next page. */
    let pageCursor: string | null = null;
    for (const msg of messages) {
      maxSeen = maxSeen ? maxMessageId(maxSeen, msg.id) : msg.id;
      const existing = await db
        .select({
          ocrText: messagesRaw.ocrText,
          ocrProvider: messagesRaw.ocrProvider,
          visionKind: messagesRaw.visionKind,
          visionJson: messagesRaw.visionJson,
        })
        .from(messagesRaw)
        .where(eq(messagesRaw.id, msg.id))
        .limit(1);
      await ingestMessage(token, msg, {
        ocrText: existing[0]?.ocrText ?? null,
        ocrProvider: existing[0]?.ocrProvider ?? null,
        visionKind: existing[0]?.visionKind ?? null,
        visionJson: existing[0]?.visionJson ?? null,
      });
      processed++;
      pageCursor = msg.id;
      if (cap !== undefined && processed >= cap) {
        truncatedByCap = true;
        break;
      }
    }

    if (!pageCursor) break;
    beforeId = pageCursor;
    if (truncatedByCap) break;
    await sleep(400);
  }

  const [row] = await db
    .select({ m: max(messagesRaw.id) })
    .from(messagesRaw)
    .where(eq(messagesRaw.groupId, groupId));

  const maxIdInDb = (row?.m as string | null) ?? maxSeen;
  const fullyBackfilled = !truncatedByCap;

  await db
    .insert(syncState)
    .values({
      groupId,
      lastAfterId: maxIdInDb,
      backfillComplete: fullyBackfilled,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: syncState.groupId,
      set: {
        lastAfterId: maxIdInDb,
        backfillComplete: fullyBackfilled,
        updatedAt: new Date(),
      },
    });

  return {
    mode: "backfill",
    messagesProcessed: processed,
    lastAfterId: maxIdInDb,
    backfillComplete: fullyBackfilled,
    truncated: truncatedByCap || undefined,
    backfillMax: cap,
  };
}

export async function runFullSync(
  token: string,
  groupId: string,
): Promise<{ backfill: SyncResult; incremental: SyncResult }> {
  const backfill = await runBackfillSync(token, groupId);
  const incremental = await runIncrementalSync(token, groupId);
  return { backfill, incremental };
}
