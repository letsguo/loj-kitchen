import { NextResponse } from "next/server";
import {
  runBackfillSync,
  runFullSync,
  runIncrementalSync,
} from "@/lib/sync";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function checkSecret(req: Request, bodySecret?: string) {
  const expected = process.env.SYNC_SECRET;
  if (!expected) return true;
  const header = req.headers.get("x-sync-secret");
  if (header === expected) return true;
  if (bodySecret === expected) return true;
  return false;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string;
    secret?: string;
  };

  if (!checkSecret(req, body.secret)) {
    return unauthorized();
  }

  const token = process.env.GROUPME_TOKEN;
  const groupId = process.env.GROUPME_GROUP_ID;
  if (!token || !groupId) {
    return NextResponse.json(
      { error: "GROUPME_TOKEN and GROUPME_GROUP_ID must be set" },
      { status: 500 },
    );
  }

  let mode: "incremental" | "backfill" | "full" = "incremental";
  if (body.mode === "backfill") mode = "backfill";
  if (body.mode === "full") mode = "full";
  if (body.mode === "incremental") mode = "incremental";

  try {
    if (mode === "backfill") {
      const result = await runBackfillSync(token, groupId);
      return NextResponse.json(result);
    }
    if (mode === "full") {
      const result = await runFullSync(token, groupId);
      return NextResponse.json(result);
    }
    const result = await runIncrementalSync(token, groupId);
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
