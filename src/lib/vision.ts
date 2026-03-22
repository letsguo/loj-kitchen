import OpenAI from "openai";

export type VisionKind = "menu" | "meal" | "other" | "uncertain";

export type VisionImageAnalysis = {
  imageUrl: string;
  kind: VisionKind;
  menuText: string;
  menuItems: string[];
  mealNameGuess: string;
  matchedMenuTitle: string;
  confidence: number;
  notes: string;
};

export type VisionMessageAnalysis = {
  provider: "openai_responses";
  model: string;
  analyzedAt: string;
  items: VisionImageAnalysis[];
};

const DEFAULT_MODEL = "gpt-4o-mini";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 2,
      timeout: 30_000,
    });
  }
  return client;
}

function readModel(): string {
  return process.env.OPENAI_VISION_MODEL?.trim() || DEFAULT_MODEL;
}

export function isVisionConfigured(): boolean {
  if (process.env.SKIP_VISION === "1") return false;
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function clampConfidence(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, 24);
}

function parseVisionOutput(raw: string, imageUrl: string): VisionImageAnalysis | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const kindRaw = typeof data.kind === "string" ? data.kind : "uncertain";
    const kind: VisionKind =
      kindRaw === "menu" ||
      kindRaw === "meal" ||
      kindRaw === "other" ||
      kindRaw === "uncertain"
        ? kindRaw
        : "uncertain";
    return {
      imageUrl,
      kind,
      menuText: typeof data.menu_text === "string" ? data.menu_text.trim() : "",
      menuItems: asStringArray(data.menu_items),
      mealNameGuess:
        typeof data.meal_name_guess === "string"
          ? data.meal_name_guess.trim()
          : "",
      matchedMenuTitle:
        typeof data.match_to_menu_title === "string"
          ? data.match_to_menu_title.trim()
          : "",
      confidence: clampConfidence(data.confidence),
      notes: typeof data.notes === "string" ? data.notes.trim() : "",
    };
  } catch {
    return null;
  }
}

function buildPrompt(caption: string, menuTitles: string[]): string {
  const normalizedTitles = [...new Set(menuTitles.map((s) => s.trim()).filter(Boolean))].slice(
    0,
    80,
  );
  const menuSection =
    normalizedTitles.length > 0
      ? `Known recent menu titles:\n${normalizedTitles.map((t) => `- ${t}`).join("\n")}`
      : "Known recent menu titles: (none)";
  return [
    "You are analyzing ONE cafeteria/group meal photo.",
    "Classify the image as one of: menu, meal, other, uncertain.",
    "If it is a menu image, extract readable menu text and a list of menu dish lines.",
    "If it is a meal image, infer the likely dish name. If it matches one known menu title, set match_to_menu_title exactly to that title.",
    "If uncertain, return uncertain with low confidence.",
    "Use concise text.",
    `Caption text (may be empty): "${caption.trim()}"`,
    menuSection,
  ].join("\n");
}

async function analyzeImage(
  imageUrl: string,
  caption: string,
  menuTitles: string[],
): Promise<VisionImageAnalysis | null> {
  const response = await getClient().responses.create({
    model: readModel(),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt(caption, menuTitles) },
          { type: "input_image", image_url: imageUrl, detail: "low" },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "menu_vision_result",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["menu", "meal", "other", "uncertain"] },
            menu_text: { type: "string" },
            menu_items: {
              type: "array",
              items: { type: "string" },
              maxItems: 24,
            },
            meal_name_guess: { type: "string" },
            match_to_menu_title: { type: "string" },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            notes: { type: "string" },
          },
          required: [
            "kind",
            "menu_text",
            "menu_items",
            "meal_name_guess",
            "match_to_menu_title",
            "confidence",
            "notes",
          ],
        },
      },
    },
    temperature: 0,
    max_output_tokens: 700,
  });

  const raw = response.output_text?.trim();
  if (!raw) return null;
  return parseVisionOutput(raw, imageUrl);
}

export async function analyzeMessageImages(
  imageUrls: string[],
  caption: string,
  menuTitles: string[],
): Promise<VisionMessageAnalysis | null> {
  if (process.env.SKIP_VISION === "1") return null;
  if (!isVisionConfigured()) return null;

  const analyses: VisionImageAnalysis[] = [];
  for (const imageUrl of imageUrls) {
    try {
      const result = await analyzeImage(imageUrl, caption, menuTitles);
      if (result) analyses.push(result);
    } catch (e) {
      console.error("OpenAI vision analysis failed for", imageUrl, e);
    }
  }
  if (analyses.length === 0) return null;
  return {
    provider: "openai_responses",
    model: readModel(),
    analyzedAt: new Date().toISOString(),
    items: analyses,
  };
}
