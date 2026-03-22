# LOJ Kitchen

Import a GroupMe group’s food content, analyze menu + meal images with **OpenAI vision**, parse menu lines into dishes and ingredients, and link meal photos back to likely menu items.

**Database:** **PostgreSQL** (e.g. [Neon](https://neon.tech/) or [Supabase](https://supabase.com/) free tier).  
**Deploy:** [Vercel](https://vercel.com/) — see [Deploy on Vercel](#deploy-on-vercel).

## Local setup

1. **Postgres URL** — create a free Neon (or Supabase) project and copy the **pooled** connection string (`sslmode=require` is typical).

2. **Env** — copy `.env.example` to `.env.local` and set at least:

   - `DATABASE_URL` — `postgresql://...`
   - `GROUPME_TOKEN`, `GROUPME_GROUP_ID`
   - `OPENAI_API_KEY` — your OpenAI API key
   - Optional: `OPENAI_VISION_MODEL` — defaults to `gpt-4o-mini` (low-cost model)
   - Optional: `SKIP_VISION=1` to skip image analysis

3. **Schema** — with `DATABASE_URL` set:

   ```bash
   npm run db:push
   ```

4. **GroupMe** — find your group id:

   ```bash
   npm run dev
   curl -s "http://localhost:3000/api/groups"
   ```

5. **Run**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000). Use **Backfill history** once, then **Incremental**.

### Parsing behavior

- **Image-only** dish extraction: text-only chat messages are not parsed into dishes.
- Menu images are parsed into dish lines.
- Meal images are matched to recent menu dish titles when confidence is high enough.

### Quick backfill cap

Set `BACKFILL_MAX_MESSAGES=20` in `.env.local` to ingest only the 20 newest messages while testing. Remove for full history. While set, `backfillComplete` stays `false` until an uncapped backfill.

## Deploy on Vercel

1. Push the repo to GitHub and **Import** the project in Vercel.
2. **Environment variables** (Vercel → Project → Settings → Environment Variables):

   | Variable | Notes |
   |----------|--------|
   | `DATABASE_URL` | Neon pooled Postgres URL |
   | `GROUPME_TOKEN`, `GROUPME_GROUP_ID` | From GroupMe dev portal |
   | `OPENAI_API_KEY` | OpenAI API key for menu/meal image analysis |
   | `OPENAI_VISION_MODEL` | Optional. Defaults to `gpt-4o-mini` |
   | `SYNC_SECRET` | Protects `POST /api/sync` if you call it manually |
   | `CRON_SECRET` | Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes; if omitted, `SYNC_SECRET` is used |

3. **First deploy** — from your machine (or CI), with production `DATABASE_URL`:

   ```bash
   DATABASE_URL="postgresql://..." npm run db:push
   ```

4. **Cron** — [`vercel.json`](vercel.json) schedules `GET /api/cron/sync` every 6 hours (incremental sync). Cron availability depends on your Vercel plan; adjust the schedule or disable `vercel.json` if needed.

5. Set **`CRON_SECRET`** in Vercel so the cron request is authenticated (see [Vercel Cron security](https://vercel.com/docs/cron-jobs#securing-cron-jobs)).

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/groups` | List group ids/names (needs `GROUPME_TOKEN`) |
| `GET /api/dishes?ingredient=x&ingredient=y&match=all\|any` | Filter dishes |
| `GET /api/ingredients` | Ingredient names for autocomplete |
| `POST /api/sync` | Body `{ "mode": "incremental" \| "backfill" \| "full" }`. Optional `SYNC_SECRET` via `x-sync-secret` or body `secret`. |
| `GET /api/cron/sync` | **Vercel Cron** — incremental sync; `Authorization: Bearer <CRON_SECRET>`. |

The home page uses a **server action** for sync (no secret in the browser for manual clicks).

## Customizing ingredients

Edit [`data/ingredient-aliases.json`](data/ingredient-aliases.json): keys are canonical names, values are aliases mapped to that ingredient during parsing.

## Notes

- `drizzle.config.ts` requires `DATABASE_URL` when running `npm run db:push` / `db:studio`.
- `pg` pool uses `max: 1` to reduce connection churn on serverless; Neon pooled URLs are a good fit.
- OpenAI image analysis runs in Node runtime route handlers/server actions and deploys cleanly to Vercel.
