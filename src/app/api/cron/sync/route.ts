import { NextResponse } from "next/server";
import { runIncrementalSync } from "@/lib/sync";

export const runtime = "nodejs";

/**
 * Vercel Cron invokes this route with GET.
 * Set CRON_SECRET in Vercel; the platform sends `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET ?? process.env.SYNC_SECRET;
  if (expected) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const token = process.env.GROUPME_TOKEN;
  const groupId = process.env.GROUPME_GROUP_ID;
  if (!token || !groupId) {
    return NextResponse.json(
      { error: "GROUPME_TOKEN and GROUPME_GROUP_ID must be set" },
      { status: 500 },
    );
  }

  try {
    const result = await runIncrementalSync(token, groupId);
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
