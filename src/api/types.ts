import type { Role } from "../auth/validate";
import type { AuthMode } from "../env";

export type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  last_login_at: number | null;
};

export type UserList = {
  users: User[];
  // The screen hides the operations that exist only in password mode.
  auth_mode: AuthMode;
};

export type ApiError = {
  error: {
    // snake_case error code, e.g. `invalid_email`, `not_found`.
    code: string;
    message: string;
    // The reason for each invalid item, keyed by the item name. Only on validation errors.
    fields?: Record<string, string>;
  };
};

export type ChangeMyPasswordRequest = {
  current_password: string;
  new_password: string;
};

export type CreateUserRequest = {
  email: string;
  name?: string | null;
  password: string;
  role: Role;
};

// CreateUserRequest after validation. email is normalized and a missing or blank name is null.
export type CreateUserInput = {
  email: string;
  name: string | null;
  password: string;
  role: Role;
};

export type ResetPasswordRequest = {
  password: string;
};

export type UpdateUserRequest = {
  role: Role;
};

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
