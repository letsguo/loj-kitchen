const BASE = "https://api.groupme.com/v3";

export type GroupMeGroup = {
  id: string;
  name: string;
  type?: string;
};

export type GroupMeAttachment =
  | { type: "image"; url: string }
  | { type: string; [k: string]: unknown };

export type GroupMeMessage = {
  id: string;
  source_guid?: string;
  created_at: number;
  user_id: string;
  group_id: string;
  name: string;
  avatar_url?: string;
  text: string;
  attachments: GroupMeAttachment[];
  favorited_by?: string[];
};

type Meta = { code: number; errors?: string[] };

function assertOk(meta: Meta, ctx: string) {
  if (meta.code !== 200) {
    throw new Error(
      `${ctx}: ${meta.errors?.join("; ") ?? `code ${meta.code}`}`,
    );
  }
}

export async function listGroups(
  token: string,
  page = 1,
): Promise<GroupMeGroup[]> {
  const url = new URL(`${BASE}/groups`);
  url.searchParams.set("token", token);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", "100");
  url.searchParams.set("omit", "memberships");
  const res = await fetch(url.toString());
  const data = (await res.json()) as {
    meta: Meta;
    response: GroupMeGroup[];
  };
  assertOk(data.meta, "listGroups");
  return data.response ?? [];
}

export async function fetchMessages(
  token: string,
  groupId: string,
  opts: { limit?: number; before_id?: string; after_id?: string },
): Promise<{ messages: GroupMeMessage[]; count: number }> {
  const url = new URL(`${BASE}/groups/${groupId}/messages`);
  url.searchParams.set("token", token);
  url.searchParams.set("limit", String(opts.limit ?? 100));
  if (opts.before_id) url.searchParams.set("before_id", opts.before_id);
  if (opts.after_id) url.searchParams.set("after_id", opts.after_id);
  const res = await fetch(url.toString());
  if (res.status === 304) {
    return { messages: [], count: 0 };
  }
  const data = (await res.json()) as {
    meta: Meta;
    response: { messages: GroupMeMessage[]; count: number };
  };
  assertOk(data.meta, "fetchMessages");
  const inner = data.response;
  return {
    messages: inner?.messages ?? [],
    count: inner?.count ?? 0,
  };
}

export function messageImageUrls(msg: GroupMeMessage): string[] {
  const out: string[] = [];
  for (const a of msg.attachments ?? []) {
    if (a.type === "image" && typeof (a as { url?: string }).url === "string") {
      out.push((a as { url: string }).url);
    }
  }
  return out;
}
