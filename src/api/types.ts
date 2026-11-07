// The types of /api/v1/me and /api/v1/users come from @i2bskn/workers-app-core.
export type {
  ApiError,
  ChangeMyPasswordRequest,
  CreateUserInput,
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
  User,
  UserList,
} from "@i2bskn/workers-app-core";

// A site. Times are UNIX time in milliseconds.
export type Site = {
  id: string;
  name: string;
  // The normalized origin, e.g. https://example.com.
  url: string;
  // The Search Console property: sc-domain:example.com or a URL prefix such as https://example.com/.
  gsc_property: string | null;
  // The GA4 property ID (digits only).
  ga4_property_id: string | null;
  created_at: number;
  updated_at: number;
};

export type SiteList = { sites: Site[] };

export type CreateSiteRequest = {
  name: string;
  url: string;
  gsc_property?: string | null;
  ga4_property_id?: string | null;
};

// At least one of the items.
export type UpdateSiteRequest = {
  name?: string;
  url?: string;
  gsc_property?: string | null;
  ga4_property_id?: string | null;
};

// GET /api/v1/google: the service account (GOOGLE_SERVICE_ACCOUNT_KEY) that imports the data.
export type GoogleStatus = {
  configured: boolean;
  // The email to add to the Search Console and GA4 properties. null unless configured.
  client_email: string | null;
  // "invalid" when the key is set but cannot be used.
  error: "invalid" | null;
};

export type SyncDataset = "gsc_pages" | "gsc_queries" | "ga4_landing_pages";

// POST /api/v1/sites/:id/sync. Both dates are included, up to 90 days.
export type SyncRequest = {
  start_date: string;
  end_date: string;
};

export type SyncResponse = {
  // The messages queued: days times datasets.
  queued: number;
  // The distinct days queued.
  days: number;
};

export type SyncFailure = {
  date: string;
  error_code: string | null;
  error_message: string | null;
  // UNIX time in milliseconds.
  finished_at: number | null;
};

// The import state of one dataset, counted over the days of its current property. A day is available once it has
// been imported successfully; it stays available while it is imported again.
export type DatasetSyncStatus = {
  dataset: SyncDataset;
  configured: boolean;
  property: string | null;
  // The latest available day.
  latest_date: string | null;
  // The earliest available day with provisional data.
  provisional_from: string | null;
  // UNIX time in milliseconds.
  last_succeeded_at: number | null;
  available_days: number;
  // Available days whose last import stopped at the row limit.
  truncated_days: number;
  queued: number;
  running: number;
  failed: number;
  // The failed days, newest first, up to 10.
  recent_failures: SyncFailure[];
};

// GET /api/v1/sites/:id/sync. datasets is always gsc_pages, gsc_queries, ga4_landing_pages.
export type SyncStatus = {
  site_id: string;
  datasets: DatasetSyncStatus[];
};

// An article of the ledger of a site. Times are UNIX time in milliseconds.
export type Article = {
  id: string;
  site_id: string;
  title: string;
  // The canonical URL. null while the article has none (e.g. not published).
  url: string | null;
  // YYYY-MM-DD.
  published_on: string | null;
  tags: string[];
  note: string;
  created_at: number;
  updated_at: number;
};

export type ArticleSummary = Omit<Article, "note">;

// GET /api/v1/sites/:id/articles: every article of the site, unpublished first, then the newest.
export type ArticleList = { articles: ArticleSummary[] };

export type CreateArticleRequest = {
  title: string;
  url?: string | null;
  published_on?: string | null;
  tags?: string[];
  note?: string;
};

// At least one of the items. null clears url and published_on.
export type UpdateArticleRequest = Partial<CreateArticleRequest>;

// POST /api/v1/sites/:id/articles/sitemap. sitemap_url defaults to <site url>/sitemap.xml; it must be on the origin
// of the site.
export type ReadSitemapRequest = { sitemap_url?: string | null };

// A URL of the sitemap. lastmod is the date written in the sitemap (YYYY-MM-DD); registered is true when the site has
// an article with this URL.
export type SitemapUrl = { url: string; lastmod: string | null; registered: boolean };

// The URLs of the site in the order of the sitemap, at most 5000 (truncated is true when more were found).
// skipped_urls counts the URLs that are invalid or on another origin, skipped_sitemaps the child sitemaps that were
// not read. remaining is the number of articles the site can still register.
export type ReadSitemapResponse = {
  sitemap_url: string;
  urls: SitemapUrl[];
  truncated: boolean;
  skipped_urls: number;
  skipped_sitemaps: number;
  remaining: number;
};

// POST /api/v1/sites/:id/articles/import: 1 to 10 URLs of the site.
export type ImportArticlesRequest = { urls: string[] };

// url is the URL of the request; article.url is the URL after the redirects of the page.
export type ImportArticleResult =
  | { url: string; status: "created"; article: ArticleSummary }
  | { url: string; status: "exists" }
  | { url: string; status: "failed"; error: string };

// In the order of the request, duplicates removed.
export type ImportArticlesResponse = { results: ImportArticleResult[] };

// A memo of a site: research, measurement changes, competitors, article ideas and so on. Times are UNIX time in
// milliseconds.
export type Memo = {
  id: string;
  site_id: string;
  title: string;
  tags: string[];
  content: string;
  // The linked articles, by title, then by ID.
  articles: { id: string; title: string; url: string | null }[];
  created_at: number;
  updated_at: number;
};

export type MemoSummary = Omit<Memo, "content" | "articles"> & { articles: { id: string; title: string }[] };

// GET /api/v1/sites/:id/memos: the newest first, each with the first 300 characters of content. next_offset is null
// on the last page.
export type MemoList = { memos: (MemoSummary & { content_preview: string })[]; next_offset: number | null };

// The query of GET /api/v1/sites/:id/memos. created_after (included) and created_before (excluded) are RFC 3339
// date-times with an offset. limit is 1 to 100 (default 50).
export type MemoListQuery = {
  // Words in the title or the content (case-insensitive for ASCII letters), 1 to 100 characters.
  q?: string;
  tag?: string;
  article_id?: string;
  created_after?: string;
  created_before?: string;
  limit?: string;
  offset?: string;
};

export type ArticleListQuery = { tag?: string };

export type CreateMemoRequest = {
  title: string;
  content?: string;
  tags?: string[];
  article_ids?: string[];
};

// At least one of the items. article_ids replaces the whole set.
export type UpdateMemoRequest = Partial<CreateMemoRequest>;

export type TagCount = { tag: string; articles: number; memos: number };

// GET /api/v1/sites/:id/tags: the most used first, up to 200. truncated is true when more exist.
export type TagList = { tags: TagCount[]; truncated: boolean };

// GET /api/v1/sites/:id/insights: the figures of the dashboard. Dates are YYYY-MM-DD; the series cover the previous
// period and the period, one entry per day, with null on the days without imported rows.
export type SearchTotals = { clicks: number; impressions: number; ctr: number | null; position: number | null };

export type SessionTotals = {
  sessions: number;
  engaged_sessions: number;
  engagement_rate: number | null;
  key_events: number;
};

// A top page or query of the period, with the values of the previous period (null when it had no rows).
export type SearchRow = SearchTotals & {
  key: string;
  previous_clicks: number | null;
  previous_impressions: number | null;
  previous_position: number | null;
};

// A top channel or landing page of the period.
export type SessionRow = SessionTotals & { key: string; previous_sessions: number | null };

export type InsightsCoverage = {
  days: number;
  available_days: number;
  provisional_days: number;
  missing_days: number;
  truncated_days: number;
  time_zone: string | null;
};

export type InsightsMemo = { id: string; title: string; tags: string[]; created_at: number };

export type InsightsResponse = {
  site_id: string;
  period: { start: string; end: string; days: number };
  previous_period: { start: string; end: string };
  // Set when the figures are of one article (article_id).
  article: { id: string; title: string; url: string | null } | null;
  // null when the site has no Search Console property, or the article has no URL.
  search: {
    property: string;
    time_zone: string;
    daily: { date: string; clicks: number | null; impressions: number | null; position: number | null }[];
    totals: SearchTotals;
    previous_totals: SearchTotals;
    // Empty for an article.
    pages: SearchRow[];
    queries: SearchRow[];
    coverage: InsightsCoverage;
  } | null;
  // null when the site has no GA4 property, or the article has no URL.
  sessions: {
    property: string;
    daily: { date: string; sessions: number | null; engaged_sessions: number | null; key_events: number | null }[];
    totals: SessionTotals;
    previous_totals: SessionTotals;
    channels: SessionRow[];
    // Empty for an article.
    landing_pages: SessionRow[];
    coverage: InsightsCoverage;
  } | null;
  // The memos created around the periods (of the article when article_id is given), newest first, up to 100.
  memos: InsightsMemo[];
};

export type InsightsQuery = { days?: string; end?: string; article_id?: string };

// GET /api/v1/sites/insights: the daily clicks and sessions of every site over the last 28 days (to yesterday in UTC).
export type OverviewSeries = { daily: number[]; total: number; previous_total: number };

export type InsightsOverview = {
  period: { start: string; end: string; days: number };
  sites: { site_id: string; clicks: OverviewSeries | null; sessions: OverviewSeries | null }[];
};
