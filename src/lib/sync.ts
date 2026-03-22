import { eq, max } from "drizzle-orm";
import { getDb } from "@/db";
import {
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
  classifyOcrMenuStrict,
  dishTitleFromLine,
  normalizeIngredientToken,
  splitIntoDishLines,
  tokenizeIngredientsFromLine,
} from "@/lib/parser";
import { fetchImageBytes, isVisionConfigured, ocrImageBuffer } from "@/lib/vision";

const OCR_PROVIDER = "gcp_vision_document";

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

/** New OCR text from this run only; `null` if skipped or failed. */
async function runOcrIfNeeded(
  msg: GroupMeMessage,
  existingOcr: string | null,
): Promise<{ ocrText: string | null; ocrProvider: string | null; ocrAt: Date | null }> {
  if (existingOcr?.trim()) {
    return { ocrText: null, ocrProvider: null, ocrAt: null };
  }
  const urls = messageImageUrls(msg);
  if (urls.length === 0) {
    return { ocrText: null, ocrProvider: null, ocrAt: null };
  }
  if (!isVisionConfigured() || process.env.SKIP_VISION === "1") {
    return { ocrText: null, ocrProvider: null, ocrAt: null };
  }
  const chunks: string[] = [];
  for (const url of urls) {
    try {
      const buf = await fetchImageBytes(url);
      const text = await ocrImageBuffer(buf);
      if (text) chunks.push(text);
    } catch (e) {
      console.error("OCR failed for", url, e);
    }
  }
  const merged = chunks.join("\n\n").trim() || null;
  return {
    ocrText: merged,
    ocrProvider: merged ? OCR_PROVIDER : null,
    ocrAt: merged ? new Date() : null,
  };
}

async function upsertMessageRow(
  msg: GroupMeMessage,
  existingOcr: string | null,
  fresh: { ocrText: string | null; ocrProvider: string | null; ocrAt: Date | null },
) {
  const db = getDb();
  const finalOcr = fresh.ocrText ?? existingOcr ?? null;

  await db
    .insert(messagesRaw)
    .values({
      id: msg.id,
      groupId: msg.group_id,
      createdAt: new Date(msg.created_at * 1000),
      text: msg.text ?? "",
      attachmentsJson: JSON.stringify(msg.attachments ?? []),
      ocrText: finalOcr,
      ocrProvider: finalOcr ? (fresh.ocrProvider ?? OCR_PROVIDER) : null,
      ocrAt: finalOcr ? (fresh.ocrAt ?? new Date()) : null,
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
            ocrText: fresh.ocrText,
            ocrProvider: fresh.ocrProvider ?? OCR_PROVIDER,
            ocrAt: fresh.ocrAt ?? new Date(),
          }
        : {
            text: msg.text ?? "",
            attachmentsJson: JSON.stringify(msg.attachments ?? []),
            userName: msg.name,
          },
    });
}

async function reparseDishesForMessage(
  msg: GroupMeMessage,
  ocrText: string | null,
) {
  const db = getDb();
  const imageUrls = messageImageUrls(msg);
  // Image-only dish extraction: skip all text-only messages.
  if (imageUrls.length === 0) {
    await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
    return;
  }

  // Strict mode: only parse OCR that strongly looks like a menu.
  const menu = classifyOcrMenuStrict(ocrText);
  if (!menu.isMenu) {
    await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));
    return;
  }

  // Parse dishes from OCR text only (ignore chat caption/body text).
  const canon = (ocrText ?? "").trim();
  if (!canon) return;

  await db.delete(dishes).where(eq(dishes.sourceMessageId, msg.id));

  const lines = splitIntoDishLines(canon);
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
        imageUrlsJson: JSON.stringify(imageUrls),
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

export async function ingestMessage(
  _token: string,
  msg: GroupMeMessage,
  existingOcr: string | null,
) {
  const fresh = await runOcrIfNeeded(msg, existingOcr);
  await upsertMessageRow(msg, existingOcr, fresh);
  const finalOcr = fresh.ocrText ?? existingOcr ?? null;
  await reparseDishesForMessage(msg, finalOcr);
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
        .select({ ocrText: messagesRaw.ocrText })
        .from(messagesRaw)
        .where(eq(messagesRaw.id, msg.id))
        .limit(1);
      await ingestMessage(token, msg, existing[0]?.ocrText ?? null);
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
        .select({ ocrText: messagesRaw.ocrText })
        .from(messagesRaw)
        .where(eq(messagesRaw.id, msg.id))
        .limit(1);
      await ingestMessage(token, msg, existing[0]?.ocrText ?? null);
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
