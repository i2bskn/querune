import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// The tables of login and sessions, from @i2bskn/workers-app-core. Re-exported so that drizzle-kit includes them.
export { users, sessions, type UserRow, type SessionRow } from "@i2bskn/workers-app-core/schema";

// The sites shown to every user. No column refers to a user, so deleting a user leaves the sites in place.
// articles, memos and sitemap_urls refer to this table with ON DELETE CASCADE. A migration that rebuilds this table (copy, DROP
// TABLE and rename, as drizzle-kit generates for some column changes) deletes the rows that refer to it, because D1
// runs migrations in a transaction where PRAGMA foreign_keys=OFF has no effect. Check generated migrations for DROP
// TABLE.
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // The normalized origin (URL.origin).
  url: text("url").notNull().unique(),
  // The Search Console property: "sc-domain:" + domain, or a URL prefix ending with "/". NULL when not set.
  gscProperty: text("gsc_property"),
  // The GA4 property ID (digits only). NULL when not set.
  ga4PropertyId: text("ga4_property_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type SiteRow = typeof sites.$inferSelect;

// The datasets that are imported for each site (src/sync/).
export const DATASETS = ["gsc_pages", "gsc_queries", "ga4_landing_pages", "ga4_pages"] as const;
const DATASET_CHECK = sql.raw("('gsc_pages', 'gsc_queries', 'ga4_landing_pages', 'ga4_pages')");

// The datasets imported from GA4: their property is the GA4 property ID and their dates are in its time zone.
export const GA4_DATASETS = ["ga4_landing_pages", "ga4_pages"] as const satisfies readonly (typeof DATASETS)[number][];

export function isGa4Dataset(dataset: (typeof DATASETS)[number]): dataset is (typeof GA4_DATASETS)[number] {
  return (GA4_DATASETS as readonly string[]).includes(dataset);
}

// The imported rows. site_id refers to sites.id without a foreign key: the rows of a deleted site are removed later
// through pending_purges. property is the property the row was imported from; reads use only the rows of the
// current property of the site. date is YYYY-MM-DD. run_id is the import (sync_days.run_id) that last wrote the row.

// Search Console, by page and day. date is in Pacific Time.
export const gscPageDaily = sqliteTable(
  "gsc_page_daily",
  {
    siteId: text("site_id").notNull(),
    property: text("property").notNull(),
    date: text("date").notNull(),
    // The URL as Search Console returned it.
    page: text("page").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    // The average position as Search Console returned it.
    position: real("position").notNull(),
    runId: text("run_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.property, t.date, t.page] })],
);

// Search Console, by page, query and day. date is in Pacific Time.
export const gscQueryDaily = sqliteTable(
  "gsc_query_daily",
  {
    siteId: text("site_id").notNull(),
    property: text("property").notNull(),
    date: text("date").notNull(),
    page: text("page").notNull(),
    query: text("query").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    position: real("position").notNull(),
    runId: text("run_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.property, t.date, t.page, t.query] })],
);

// GA4, by landing page, session default channel group and day. property is the GA4 property ID; date is in the
// time zone of the property.
export const ga4LandingDaily = sqliteTable(
  "ga4_landing_daily",
  {
    siteId: text("site_id").notNull(),
    property: text("property").notNull(),
    date: text("date").notNull(),
    // landingPage (a path) as GA4 returned it, including "(not set)".
    landingPage: text("landing_page").notNull(),
    // sessionDefaultChannelGroup as GA4 returned it.
    channelGroup: text("channel_group").notNull(),
    sessions: integer("sessions").notNull(),
    engagedSessions: integer("engaged_sessions").notNull(),
    keyEvents: real("key_events").notNull(),
    runId: text("run_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.property, t.date, t.landingPage, t.channelGroup] })],
);

// GA4, by host name, page path and day: every view of a page, not only the first page of a session. property is the
// GA4 property ID; date is in the time zone of the property.
export const ga4PageDaily = sqliteTable(
  "ga4_page_daily",
  {
    siteId: text("site_id").notNull(),
    property: text("property").notNull(),
    date: text("date").notNull(),
    // hostName as GA4 returned it, including "(not set)".
    hostName: text("host_name").notNull(),
    // pagePath (a path without the query string) as GA4 returned it, including "(not set)".
    pagePath: text("page_path").notNull(),
    // screenPageViews.
    views: integer("views").notNull(),
    // userEngagementDuration, in seconds.
    engagementSeconds: real("engagement_seconds").notNull(),
    runId: text("run_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.property, t.date, t.hostName, t.pagePath] })],
);

// The import state of each day of each dataset of a site. The last_* columns describe the last successful import;
// they and the imported rows stay while the day is imported again or when that fails.
export const syncDays = sqliteTable(
  "sync_days",
  {
    siteId: text("site_id").notNull(),
    dataset: text("dataset", { enum: DATASETS }).notNull(),
    date: text("date").notNull(),
    // The property of the current import.
    property: text("property").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] }).notNull(),
    // The ID (ULID) of the current import, carried by every message of it.
    runId: text("run_id").notNull(),
    queuedAt: integer("queued_at").notNull(),
    // When the first page started.
    startedAt: integer("started_at"),
    // Updated with every page.
    heartbeatAt: integer("heartbeat_at"),
    // When the day became succeeded or failed.
    finishedAt: integer("finished_at"),
    // Set when failed (error_message up to 500 characters); NULL otherwise.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    lastSucceededAt: integer("last_succeeded_at"),
    lastDataState: text("last_data_state", { enum: ["final", "provisional"] }),
    lastRowCount: integer("last_row_count"),
    // 1 when the last successful import stopped at the row limit.
    lastTruncated: integer("last_truncated"),
    // America/Los_Angeles for Search Console, the time zone of the property for GA4.
    lastTimeZone: text("last_time_zone"),
    // GA4: 1 when a page of the last successful import was subject to thresholding or had rows aggregated into
    // "(other)", 0 otherwise. NULL for Search Console and for the days imported before this column existed.
    lastThresholded: integer("last_thresholded"),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.dataset, t.date] }),
    index("sync_days_site_dataset_status_idx").on(t.siteId, t.dataset, t.status),
    index("sync_days_status_heartbeat_idx").on(t.status, t.heartbeatAt),
    check("sync_days_dataset_check", sql`${t.dataset} IN ${DATASET_CHECK}`),
    check("sync_days_status_check", sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed')`),
    check(
      "sync_days_last_data_state_check",
      sql`${t.lastDataState} IS NULL OR ${t.lastDataState} IN ('final', 'provisional')`,
    ),
  ],
);

// Imported rows waiting to be deleted after a site was deleted or its property changed (src/sync/consumer.ts).
export const pendingPurges = sqliteTable(
  "pending_purges",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    dataset: text("dataset", { enum: DATASETS }).notNull(),
    // NULL: every row of the dataset of the site. Otherwise only the rows of this property.
    property: text("property"),
    createdAt: integer("created_at").notNull(),
    // When the purge message was last sent.
    attemptedAt: integer("attempted_at"),
  },
  (t) => [check("pending_purges_dataset_check", sql`${t.dataset} IN ${DATASET_CHECK}`)],
);

export type SyncDayRow = typeof syncDays.$inferSelect;
export type PendingPurgeRow = typeof pendingPurges.$inferSelect;

// The article ledger of a site. url is the canonical URL (NULL while the article has none). published_on is
// YYYY-MM-DD. tags is a JSON array of strings. memo_articles refers to this table with ON DELETE CASCADE: a
// migration that rebuilds this table deletes the links (see sites). Check generated migrations for DROP TABLE.
export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url"),
    publishedOn: text("published_on"),
    tags: text("tags").notNull().default("[]"),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // SQLite allows several NULLs in a unique index.
    uniqueIndex("articles_site_id_url_unique").on(t.siteId, t.url),
    index("articles_site_id_published_on_idx").on(t.siteId, t.publishedOn),
  ],
);

// The notes about a site: research, measurement changes, competitors, article ideas and so on. tags is a JSON array of
// strings. memo_articles refers to this table with ON DELETE CASCADE: a migration that rebuilds this table deletes the
// links (see sites). Check generated migrations for DROP TABLE.
export const memos = sqliteTable(
  "memos",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    tags: text("tags").notNull().default("[]"),
    content: text("content").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("memos_site_id_created_at_idx").on(t.siteId, t.createdAt)],
);

// The articles a memo is about. Both sides belong to the same site.
export const memoArticles = sqliteTable(
  "memo_articles",
  {
    memoId: text("memo_id")
      .notNull()
      .references(() => memos.id, { onDelete: "cascade" }),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.memoId, t.articleId] }), index("memo_articles_article_id_idx").on(t.articleId)],
);

export type ArticleRow = typeof articles.$inferSelect;
export type MemoRow = typeof memos.$inferSelect;

// URLs seen in the sitemap of a site by the daily article sync. A URL seen once is never registered again by the
// sync, so that an article deleted by a user does not come back. Rows are never deleted except with the site (or
// when the URL of the site changes).
export const sitemapUrls = sqliteTable(
  "sitemap_urls",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // epoch ms.
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.url] })],
);
