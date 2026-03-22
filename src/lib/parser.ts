import fs from "fs";
import path from "path";

type AliasFile = Record<string, string[]>;

type AliasMaps = {
  aliasToCanonical: Map<string, string>;
};

let cached: AliasMaps | null = null;

export function loadAliasMaps(): AliasMaps {
  if (cached) return cached;
  const filePath = path.join(process.cwd(), "data", "ingredient-aliases.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AliasFile;
  const aliasToCanonical = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(raw)) {
    const c = canonical.toLowerCase().trim();
    aliasToCanonical.set(c, c);
    for (const a of aliases) {
      aliasToCanonical.set(a.toLowerCase().trim(), c);
    }
  }
  cached = { aliasToCanonical };
  return cached;
}

export function normalizeIngredientToken(raw: string): string {
  const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return "";
  const { aliasToCanonical } = loadAliasMaps();
  if (aliasToCanonical.has(t)) {
    return aliasToCanonical.get(t)!;
  }
  for (const [alias, canon] of aliasToCanonical) {
    if (alias.length >= 3 && t.includes(alias)) {
      return canon;
    }
  }
  return t;
}

export type MenuClassification = {
  isMenu: boolean;
  score: number;
  reasons: string[];
};

/**
 * Strict menu classifier for OCR output:
 * requires strong keyword + structure signals to reduce false positives.
 */
export function classifyOcrMenuStrict(ocrText: string | null): MenuClassification {
  const text = (ocrText ?? "").toLowerCase().trim();
  if (!text) {
    return { isMenu: false, score: 0, reasons: ["empty_ocr"] };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const shortLines = lines.filter((l) => l.length >= 3 && l.length <= 44).length;
  const dayHeaderLines = lines.filter((l) =>
    /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*:/.test(l),
  ).length;
  const bulletOrNumbered = lines.filter((l) =>
    /^([\-\*•]\s+|\d+[\.\)]\s+)/.test(l),
  ).length;

  const keywords = [
    "menu",
    "week",
    "weekly",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "breakfast",
    "lunch",
    "dinner",
  ];
  const keywordHits = keywords.filter((k) => text.includes(k)).length;

  let score = 0;
  const reasons: string[] = [];
  if (text.length >= 80) {
    score += 1;
    reasons.push("length");
  }
  if (keywordHits >= 2) {
    score += 2;
    reasons.push("keywords");
  }
  if (dayHeaderLines >= 1 || keywordHits >= 4) {
    score += 2;
    reasons.push("day_or_many_keywords");
  }
  if (shortLines >= 5) {
    score += 1;
    reasons.push("multi_line_structure");
  }
  if (bulletOrNumbered >= 3) {
    score += 1;
    reasons.push("list_markers");
  }

  const isMenu = score >= 5;
  return { isMenu, score, reasons };
}

export function splitIntoDishLines(canonicalText: string): string[] {
  const lines = canonicalText.split(/\r?\n/);
  const out: string[] = [];
  for (let line of lines) {
    line = line
      .replace(/^\s*[\-\*•]\s*/, "")
      .replace(/^\s*\d+[\.)]\s*/, "")
      .trim();
    if (line.length < 4) continue;
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*:?\s*$/i.test(line)) {
      continue;
    }
    if (!/[a-z]/i.test(line)) continue;
    if (!/\s/.test(line) && line.length < 14) continue;
    out.push(line);
  }
  return out;
}

export function tokenizeIngredientsFromLine(line: string): string[] {
  const withoutParens = line.replace(/\([^)]*\)/g, " ");
  const parts = withoutParens.split(
    /[,/|]|(?:\s+with\s+)|(?:\s+and\s+)/i,
  );
  const tokens: string[] = [];
  for (const p of parts) {
    const t = p
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length < 2) continue;
    tokens.push(t);
  }
  return tokens;
}

export function dishTitleFromLine(line: string): string {
  const beforeComma = line.split(",")[0]?.trim() ?? line;
  return beforeComma.length > 120
    ? `${beforeComma.slice(0, 117)}...`
    : beforeComma;
}
