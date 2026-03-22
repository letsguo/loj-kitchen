"use server";

import {
  runBackfillSync,
  runFullSync,
  runIncrementalSync,
} from "@/lib/sync";

export type SyncActionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export async function kitchenSync(
  mode: "incremental" | "backfill" | "full",
): Promise<SyncActionResult> {
  const token = process.env.GROUPME_TOKEN;
  const groupId = process.env.GROUPME_GROUP_ID;
  if (!token || !groupId) {
    return {
      ok: false,
      error: "GROUPME_TOKEN and GROUPME_GROUP_ID must be set",
    };
  }
  try {
    if (mode === "backfill") {
      return { ok: true, result: await runBackfillSync(token, groupId) };
    }
    if (mode === "full") {
      return { ok: true, result: await runFullSync(token, groupId) };
    }
    return { ok: true, result: await runIncrementalSync(token, groupId) };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    return { ok: false, error: message };
  }
}
