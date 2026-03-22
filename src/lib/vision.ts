let clientPromise: Promise<
  InstanceType<
    Awaited<typeof import("@google-cloud/vision")>["ImageAnnotatorClient"]
  >
> | null = null;

function parseServiceAccountJson(): Record<string, unknown> | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { ImageAnnotatorClient } = await import("@google-cloud/vision");
      const credentials = parseServiceAccountJson();
      if (credentials) {
        return new ImageAnnotatorClient({ credentials });
      }
      return new ImageAnnotatorClient();
    })();
  }
  return clientPromise;
}

export function isVisionConfigured(): boolean {
  if (process.env.SKIP_VISION === "1") return false;
  if (parseServiceAccountJson()) return true;
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

/** Returns trimmed full document text, or empty string if none. */
export async function ocrImageBuffer(buf: Buffer): Promise<string> {
  if (process.env.SKIP_VISION === "1") {
    return "";
  }
  const client = await getClient();
  const [result] = await client.documentTextDetection({
    image: { content: buf },
  });
  const text = result.fullTextAnnotation?.text?.trim() ?? "";
  return text;
}

export async function fetchImageBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "loj-kitchen/1.0" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Image fetch failed ${res.status} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
