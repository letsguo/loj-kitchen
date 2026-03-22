import { NextResponse } from "next/server";
import { listGroups } from "@/lib/groupme";

export const runtime = "nodejs";

/** Lists your GroupMe groups (ids + names) — helps set GROUPME_GROUP_ID. */
export async function GET() {
  const token = process.env.GROUPME_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "GROUPME_TOKEN must be set" },
      { status: 500 },
    );
  }
  try {
    const groups: { id: string; name: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await listGroups(token, page);
      if (batch.length === 0) break;
      for (const g of batch) {
        groups.push({ id: g.id, name: g.name });
      }
      if (batch.length < 100) break;
    }
    return NextResponse.json({ groups });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list groups";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
