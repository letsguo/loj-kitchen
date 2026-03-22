"use client";

import { kitchenSync } from "@/app/actions/sync";
import { useCallback, useEffect, useMemo, useState } from "react";

type Dish = {
  id: number;
  title: string;
  rawLine: string;
  sourceMessageId: string;
  imageUrls: string[];
  ingredients: string[];
  dishPhotos: {
    sourceMessageId: string;
    imageUrl: string;
    caption: string;
    matchedTitle: string | null;
    confidence: number | null;
  }[];
};

export default function Home() {
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [ingredientOptions, setIngredientOptions] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [warning, setWarning] = useState<string | null>(null);

  const loadDishes = useCallback(async () => {
    setLoading(true);
    setWarning(null);
    try {
      const params = new URLSearchParams();
      for (const i of selected) {
        params.append("ingredient", i);
      }
      params.set("match", match);
      const res = await fetch(`/api/dishes?${params}`);
      const data = await res.json();
      setDishes(data.dishes ?? []);
      setWarning(data.warning ?? null);
    } finally {
      setLoading(false);
    }
  }, [selected, match]);

  useEffect(() => {
    void loadDishes();
  }, [loadDishes]);

  useEffect(() => {
    void fetch("/api/ingredients")
      .then((r) => r.json())
      .then((d) => setIngredientOptions(d.ingredients ?? []))
      .catch(() => setIngredientOptions([]));
  }, [dishes]);

  const suggestions = useMemo(() => {
    const q = input.toLowerCase().trim();
    if (!q) return [];
    return ingredientOptions
      .filter((n) => n.includes(q) && !selected.includes(n))
      .slice(0, 12);
  }, [input, ingredientOptions, selected]);

  async function runSync(mode: "incremental" | "backfill" | "full") {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const data = await kitchenSync(mode);
      if (!data.ok) {
        setSyncMsg(data.error);
        return;
      }
      setSyncMsg(JSON.stringify(data.result, null, 2));
      await loadDishes();
      const ing = await fetch("/api/ingredients").then((r) => r.json());
      setIngredientOptions(ing.ingredients ?? []);
    } finally {
      setSyncing(false);
    }
  }

  function addIngredient(name: string) {
    const n = name.toLowerCase().trim();
    if (!n || selected.includes(n)) return;
    setSelected((s) => [...s, n]);
    setInput("");
  }

  function removeIngredient(name: string) {
    setSelected((s) => s.filter((x) => x !== name));
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white px-6 py-5">
        <h1 className="text-xl font-semibold tracking-tight text-stone-800">
          LOJ Kitchen
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          Dishes from GroupMe menus, linked to meal photos.
        </p>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-stone-500">
            Sync
          </h2>
          <p className="mt-2 text-sm text-stone-600">
            First run <strong>Backfill</strong> once, then use{" "}
            <strong>Incremental</strong> (or cron) for new messages. Requires{" "}
            <code className="rounded bg-stone-100 px-1">.env</code> GroupMe vars;
            Vision needs{" "}
            <code className="rounded bg-stone-100 px-1">OPENAI_API_KEY</code>.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={syncing}
              onClick={() => void runSync("backfill")}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Backfill history
            </button>
            <button
              type="button"
              disabled={syncing}
              onClick={() => void runSync("incremental")}
              className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white hover:bg-stone-900 disabled:opacity-50"
            >
              Incremental
            </button>
            <button
              type="button"
              disabled={syncing}
              onClick={() => void runSync("full")}
              className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:opacity-50"
            >
              Full (backfill + incremental)
            </button>
          </div>
          {syncMsg ? (
            <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-stone-900 p-3 text-xs text-stone-100">
              {syncMsg}
            </pre>
          ) : null}
        </section>

        <section className="mt-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-stone-500">
            Ingredients I have
          </h2>
          <div className="relative mt-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (suggestions[0]) addIngredient(suggestions[0]);
                  else if (input.trim()) addIngredient(input);
                }
              }}
              placeholder="Type e.g. chicken thigh, rice…"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none ring-amber-500 focus:border-amber-500 focus:ring-1"
            />
            {suggestions.length > 0 ? (
              <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
                {suggestions.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-stone-100"
                      onClick={() => addIngredient(s)}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => removeIngredient(s)}
                className="group flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm text-amber-950 hover:bg-amber-200"
              >
                {s}
                <span className="text-amber-700 group-hover:text-amber-900">
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-stone-700">
              <input
                type="radio"
                name="match"
                checked={match === "all"}
                onChange={() => setMatch("all")}
              />
              Match all selected
            </label>
            <label className="flex items-center gap-2 text-stone-700">
              <input
                type="radio"
                name="match"
                checked={match === "any"}
                onChange={() => setMatch("any")}
              />
              Match any
            </label>
          </div>
          {warning ? (
            <p className="mt-3 text-sm text-amber-800">{warning}</p>
          ) : null}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium uppercase tracking-wide text-stone-500">
            Dishes {loading ? "(loading…)" : `(${dishes.length})`}
          </h2>
          <ul className="mt-4 space-y-4">
            {dishes.map((d) => (
              <li
                key={d.id}
                className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
              >
                <h3 className="font-medium text-stone-900">{d.title}</h3>
                <p className="mt-1 text-sm text-stone-600">{d.rawLine}</p>
                {d.ingredients.length > 0 ? (
                  <p className="mt-2 text-xs text-stone-500">
                    {d.ingredients.join(" · ")}
                  </p>
                ) : null}
                {d.imageUrls.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {d.imageUrls.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-amber-700 underline hover:text-amber-900"
                      >
                        Menu image
                      </a>
                    ))}
                  </div>
                ) : null}
                {d.dishPhotos.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-stone-500">
                      Matched meal photos ({d.dishPhotos.length})
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {d.dishPhotos.map((p) => (
                        <a
                          key={`${p.sourceMessageId}-${p.imageUrl}`}
                          href={p.imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
                          title={
                            p.caption
                              ? `${p.caption}${p.confidence !== null ? ` (confidence ${p.confidence})` : ""}`
                              : p.confidence !== null
                                ? `confidence ${p.confidence}`
                                : "Linked meal photo"
                          }
                        >
                          Meal photo
                          {p.confidence !== null ? ` (${p.confidence})` : ""}
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {!loading && dishes.length === 0 ? (
            <p className="mt-6 text-center text-sm text-stone-500">
              No dishes yet. Run a sync with GroupMe + OpenAI vision configured,
              or loosen ingredient filters.
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
