import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const syncState = pgTable("sync_state", {
  groupId: text("group_id").primaryKey(),
  lastAfterId: text("last_after_id"),
  backfillComplete: boolean("backfill_complete").notNull().default(false),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull(),
});

export const messagesRaw = pgTable("messages_raw", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull(),
  text: text("text").notNull().default(""),
  attachmentsJson: text("attachments_json").notNull().default("[]"),
  ocrText: text("ocr_text"),
  ocrProvider: text("ocr_provider"),
  ocrAt: timestamp("ocr_at", { mode: "date", withTimezone: true }),
  userId: text("user_id"),
  userName: text("user_name"),
});

export const dishes = pgTable("dishes", {
  id: serial("id").primaryKey(),
  sourceMessageId: text("source_message_id").notNull(),
  title: text("title").notNull(),
  rawLine: text("raw_line").notNull(),
  sortIndex: integer("sort_index").notNull().default(0),
  imageUrlsJson: text("image_urls_json").notNull().default("[]"),
});

export const ingredients = pgTable("ingredients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const dishIngredients = pgTable(
  "dish_ingredients",
  {
    dishId: integer("dish_id")
      .notNull()
      .references(() => dishes.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.dishId, t.ingredientId] }),
  }),
);
