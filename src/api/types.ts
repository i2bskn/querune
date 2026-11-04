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
