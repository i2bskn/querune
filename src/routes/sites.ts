import { Hono, type Context } from "hono";
import { asc, eq } from "drizzle-orm";
import type { CreateSiteRequest, Site, SiteList, UpdateSiteRequest } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { sites, type SiteRow } from "../db/schema";
import type { AppEnv } from "../env";
import { newSiteId, SITE_ID_PATTERN } from "../ids";
import { jsonBody, normalizeDisplayName, unknownField } from "./api";

export const MAX_SITES = 100;
const SITE_NAME_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 2048;
const DOMAIN_MAX_LENGTH = 253;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SC_DOMAIN_PREFIX = "sc-domain:";
const GA4_PROPERTY_ID_PATTERN = /^[0-9]{1,20}$/;
const FIELDS = ["name", "url", "gsc_property", "ga4_property_id"];

const siteNotFound = "サイトが見つかりません";
const invalidNameMessage = "名前は制御文字を含まない 1〜100 文字にしてください";
const invalidUrlMessage = "URL は http または https で始まる正しい形式にしてください";
const invalidGscPropertyMessage =
  "Search Console のプロパティは sc-domain:example.com か https://example.com/ の形式にしてください";
const invalidGa4PropertyMessage = "GA4 のプロパティ ID は数字だけで入力してください";
const urlConflictMessage = "この URL のサイトは登録済みです";

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

// The origin of the site (scheme, lowercase host and non-default port). The path, query and fragment are dropped.
export function normalizeSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > URL_MAX_LENGTH) return null;
  return parseHttpUrl(trimmed)?.origin ?? null;
}

// null or blank is "not set". Otherwise "sc-domain:" + a lowercase domain, or a URL prefix ending with "/".
export function normalizeGscProperty(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.slice(0, SC_DOMAIN_PREFIX.length).toLowerCase() === SC_DOMAIN_PREFIX) {
    const domain = trimmed.slice(SC_DOMAIN_PREFIX.length).toLowerCase();
    if (domain.length > DOMAIN_MAX_LENGTH || !DOMAIN_PATTERN.test(domain)) return { ok: false };
    return { ok: true, value: `${SC_DOMAIN_PREFIX}${domain}` };
  }
  const url = parseHttpUrl(trimmed);
  if (url === null || url.search !== "" || url.hash !== "" || !url.pathname.endsWith("/")) return { ok: false };
  if (url.href.length > URL_MAX_LENGTH) return { ok: false };
  return { ok: true, value: url.href };
}

// null or blank is "not set". Otherwise 1 to 20 digits.
export function normalizeGa4PropertyId(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  return GA4_PROPERTY_ID_PATTERN.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

type SiteInput = { name: string; url: string; gscProperty: string | null; ga4PropertyId: string | null };

// Validates the items present in the body, in the order name, url, gsc_property, ga4_property_id. With required,
// a missing name or url is invalid and a missing property is null.
function checkSiteFields(
  body: Record<string, unknown>,
  c: Context<AppEnv>,
  required: boolean,
): { ok: true; value: Partial<SiteInput> } | Response {
  const value: Partial<SiteInput> = {};
  if (required || "name" in body) {
    const name = normalizeDisplayName(body.name, SITE_NAME_MAX_LENGTH);
    if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
    value.name = name;
  }
  if (required || "url" in body) {
    const url = normalizeSiteUrl(body.url);
    if (url === null) return apiError(c, 400, "invalid_url", invalidUrlMessage);
    value.url = url;
  }
  if ("gsc_property" in body) {
    const gscProperty = normalizeGscProperty(body.gsc_property);
    if (!gscProperty.ok) return apiError(c, 400, "invalid_gsc_property", invalidGscPropertyMessage);
    value.gscProperty = gscProperty.value;
  } else if (required) {
    value.gscProperty = null;
  }
  if ("ga4_property_id" in body) {
    const ga4PropertyId = normalizeGa4PropertyId(body.ga4_property_id);
    if (!ga4PropertyId.ok) return apiError(c, 400, "invalid_ga4_property", invalidGa4PropertyMessage);
    value.ga4PropertyId = ga4PropertyId.value;
  } else if (required) {
    value.ga4PropertyId = null;
  }
  return { ok: true, value };
}

const createSiteBody = jsonBody<CreateSiteRequest, SiteInput>((body, c) => {
  const unknown = unknownField(body, FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const result = checkSiteFields(body, c, true);
  if (result instanceof Response) return result;
  return { ok: true, value: result.value as SiteInput };
});

const updateSiteBody = jsonBody<UpdateSiteRequest, Partial<SiteInput>>((body, c) => {
  const unknown = unknownField(body, FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  if (Object.keys(body).length === 0) {
    return apiError(c, 400, "invalid_request", "変更する項目を指定してください");
  }
  return checkSiteFields(body, c, false);
});

export function toApiSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    gsc_property: row.gscProperty,
    ga4_property_id: row.ga4PropertyId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// Every site, by name, then by ID.
export function listSites(db: Db): Promise<SiteRow[]> {
  return db.select().from(sites).orderBy(asc(sites.name), asc(sites.id)).all();
}

function findSite(db: Db, id: string): Promise<SiteRow | undefined> {
  return db.select().from(sites).where(eq(sites.id, id)).get();
}

// Every signed-in user can read and change the sites; there is no per-site access control.
const sitesApi = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const rows = await listSites(c.get("db"));
    const body: SiteList = { sites: rows.map(toApiSite) };
    return c.json(body, 200);
  })
  .post("/", createSiteBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const now = clock.now();
    const id = newSiteId(now);
    let changes: number;
    try {
      // The limit is checked in the same statement, so that concurrent requests cannot go over it. Once it is
      // reached, nothing is inserted and a duplicate URL is reported as limit_exceeded.
      const result = await db.$client
        .prepare(
          `INSERT INTO sites (id, name, url, gsc_property, ga4_property_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM sites) < ?`,
        )
        .bind(id, input.name, input.url, input.gscProperty, input.ga4PropertyId, now, now, MAX_SITES)
        .run();
      changes = result.meta.changes ?? 0;
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "url_conflict", urlConflictMessage);
      throw error;
    }
    if (changes === 0) return apiError(c, 409, "limit_exceeded", "サイトは 100 件まで登録できます");
    const created = await findSite(db, id);
    if (!created) throw new Error("created site not found");
    return c.json(toApiSite(created), 201);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const row = SITE_ID_PATTERN.test(id) ? await findSite(c.get("db"), id) : undefined;
    if (!row) return apiError(c, 404, "not_found", siteNotFound);
    return c.json(toApiSite(row), 200);
  })
  .patch("/:id", updateSiteBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const id = c.req.param("id");
    if (!SITE_ID_PATTERN.test(id) || !(await findSite(db, id))) {
      return apiError(c, 404, "not_found", siteNotFound);
    }
    try {
      await db
        .update(sites)
        .set({ ...input, updatedAt: clock.now() })
        .where(eq(sites.id, id))
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "url_conflict", urlConflictMessage);
      throw error;
    }
    const updated = await findSite(db, id);
    if (!updated) return apiError(c, 404, "not_found", siteNotFound);
    return c.json(toApiSite(updated), 200);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!SITE_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", siteNotFound);
    const deleted = await c.get("db").delete(sites).where(eq(sites.id, id)).returning({ id: sites.id }).all();
    if (deleted.length === 0) return apiError(c, 404, "not_found", siteNotFound);
    return c.body(null, 204);
  });

export default sitesApi;
