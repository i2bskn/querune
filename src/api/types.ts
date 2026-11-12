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

export type SyncDataset = "gsc_pages" | "gsc_queries" | "ga4_landing_pages" | "ga4_pages";

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

// The state of one day of the recent days of a dataset. final and provisional: imported successfully at least once
// (by the data state of the last success). pending: never imported successfully, queued or running. failed: never
// imported successfully, failed. missing: not asked for (for the current property).
export type RecentDayState = "final" | "provisional" | "pending" | "failed" | "missing";

export type RecentDay = {
  date: string;
  state: RecentDayState;
  // Imported successfully and being imported again (queued or running).
  updating: boolean;
  // The rows of the last successful import; null if never imported successfully.
  row_count: number | null;
  // UNIX time in milliseconds of the last successful import.
  fetched_at: number | null;
  // The error of the last import when it failed, also for a day imported successfully before.
  error_code: string | null;
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
  // The time zone of the dates: America/Los_Angeles for Search Console, the time zone of the property for GA4. null
  // when not configured, and for GA4 until the first import records it.
  time_zone: string | null;
  // false for GA4 until its time zone is recorded (expected_latest_date is then yesterday in Etc/GMT+12), and when
  // not configured.
  time_zone_known: boolean;
  // Yesterday in time_zone: the latest day that the imports are expected to have. null when not configured.
  expected_latest_date: string | null;
  // How final days are decided: by the API (Search Console; a day without rows by the days elapsed), or by the days
  // elapsed (GA4). null when not configured.
  state_basis: "api" | "elapsed_days" | null;
  // The recent days imported again every day. 0 when not configured.
  refresh_days: number;
  // The 14 days to expected_latest_date, oldest first. Empty when not configured.
  recent_days: RecentDay[];
  // The day before the oldest of recent_days that is not final, or expected_latest_date if every one is final. null
  // if the oldest is not final, or when not configured. Only recent_days are looked at.
  final_through: string | null;
};

// GET /api/v1/sites/:id/sync. datasets is always gsc_pages, gsc_queries, ga4_landing_pages, ga4_pages.
export type SyncStatus = {
  site_id: string;
  datasets: DatasetSyncStatus[];
  // The earliest final_through of the configured datasets (as date strings, each in the time zone of its dataset).
  // null if any of them is null, or without a configured dataset.
  final_through: string | null;
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
// an article with this URL, and undated when that article has no published date (importing it again fills the date).
export type SitemapUrl = { url: string; lastmod: string | null; registered: boolean; undated: boolean };

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

// url is the URL of the request; article.url is the URL after the redirects of the page. dated: a registered article
// without a published date got the date read from the page; nothing else of it changes.
export type ImportArticleResult =
  | { url: string; status: "created"; article: ArticleSummary }
  | { url: string; status: "dated"; article: ArticleSummary }
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

// The views of pages (GA4 screenPageViews: every view of a page, not only the first page of a session) and the
// engagement time (userEngagementDuration, seconds). avg_engagement_seconds_per_view is the summed engagement time
// divided by the summed views (null without views). The values are null when no day of the period is imported.
export type PageViewTotals = {
  views: number | null;
  engagement_seconds: number | null;
  avg_engagement_seconds_per_view: number | null;
};

// A top page of the period. previous_views is null when no day of the previous period is imported, 0 when the page
// had no views on the imported days.
export type PageViewRow = {
  host_name: string;
  page_path: string;
  views: number;
  engagement_seconds: number;
  avg_engagement_seconds_per_view: number | null;
  previous_views: number | null;
};

// thresholded_days: the imported days whose import was subject to GA4 thresholding or had an "(other)" row.
export type PageViewsCoverage = InsightsCoverage & { thresholded_days: number };

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
  // null when the site has no GA4 property, or the article has no URL. For an article, only the rows of its host name
  // and its path (or the path decoded) are read.
  page_views: {
    property: string;
    // The values are null on the days not imported (state is not final or provisional), 0 on an imported day without
    // rows. state is the import state of the day for the current property.
    daily: {
      date: string;
      views: number | null;
      engagement_seconds: number | null;
      state: RecentDayState;
    }[];
    totals: PageViewTotals;
    previous_totals: PageViewTotals;
    // The most viewed pages of the site; empty for an article.
    pages: PageViewRow[];
    coverage: PageViewsCoverage;
    previous_coverage: PageViewsCoverage;
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
