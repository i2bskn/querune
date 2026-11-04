import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Site } from "../src/api/types";
import type { UserRow } from "../src/db/schema";
import { newSiteId } from "../src/ids";
import { countTable, createSite, createUser, login, resetDb, send, type SessionCookies } from "./helpers";

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MISSING_ID = newSiteId(Date.UTC(2026, 0, 1));

function createRequest(json: unknown, cookies: SessionCookies = memberCookies): Promise<Response> {
  return send("/api/v1/sites", { cookies, json });
}

function updateRequest(id: string, json: unknown, cookies: SessionCookies = memberCookies): Promise<Response> {
  return send(`/api/v1/sites/${id}`, { method: "PATCH", cookies, json });
}

async function expectError(res: Response, status: number, code: string, message?: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
}

async function created(json: unknown): Promise<Site> {
  const res = await createRequest(json);
  expect(res.status).toBe(201);
  return (await res.json()) as Site;
}

describe("authentication and authorization", () => {
  it("returns 401 without a session", async () => {
    const site = await createSite();
    const requests = [
      send("/api/v1/sites"),
      send("/api/v1/sites", { json: { name: "a", url: "https://a.example.com" } }),
      send(`/api/v1/sites/${site.id}`),
      send(`/api/v1/sites/${site.id}`, { method: "PATCH", json: { name: "b" } }),
      send(`/api/v1/sites/${site.id}`, { method: "DELETE" }),
    ];
    for (const res of await Promise.all(requests)) await expectError(res, 401, "unauthorized", "ログインが必要です");
  });

  it("lets a member create, read, change and delete sites", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await send(`/api/v1/sites/${site.id}`, { cookies: memberCookies })).status).toBe(200);
    expect((await updateRequest(site.id, { name: "Blog 2" })).status).toBe(200);
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
  });

  it("shows every user the same sites", async () => {
    await created({ name: "Blog", url: "https://blog.example.com" });
    const res = await send("/api/v1/sites", { cookies: adminCookies });
    expect(((await res.json()) as { sites: Site[] }).sites.map((s) => s.name)).toEqual(["Blog"]);
  });

  it("rejects cross-origin POST, PATCH and DELETE with 403", async () => {
    const site = await createSite();
    const options = { cookies: memberCookies, origin: "https://evil.example" };
    await expectError(
      await send("/api/v1/sites", { ...options, json: { name: "a", url: "https://a.example.com" } }),
      403,
      "forbidden",
    );
    await expectError(await send(`/api/v1/sites/${site.id}`, { ...options, method: "PATCH", json: { name: "b" } }), 403, "forbidden");
    await expectError(await send(`/api/v1/sites/${site.id}`, { ...options, method: "DELETE" }), 403, "forbidden");
    expect(await countTable("sites")).toBe(1);
  });

  it("keeps the sites when the user who created them is deleted", async () => {
    await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await send(`/api/v1/users/${member.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(204);
    expect(await countTable("sites")).toBe(1);
  });
});

describe("GET /api/v1/sites", () => {
  it("lists the sites by name, then by ID", async () => {
    const b = await createSite({ name: "B" });
    const a2 = await createSite({ name: "A" });
    const a1 = await createSite({ name: "A" });
    const res = await send("/api/v1/sites", { cookies: memberCookies });
    expect(res.status).toBe(200);
    const { sites } = (await res.json()) as { sites: Site[] };
    const sameName = [a1.id, a2.id].sort();
    expect(sites.map((site) => site.id)).toEqual([...sameName, b.id]);
  });

  it("returns an empty list", async () => {
    const res = await send("/api/v1/sites", { cookies: memberCookies });
    expect(await res.json()).toEqual({ sites: [] });
  });
});

describe("POST /api/v1/sites", () => {
  it("creates a site with the normalized values", async () => {
    const site = await created({
      name: "  Blog  ",
      url: "  HTTPS://Blog.Example.COM:443/path/?q=1#top ",
      gsc_property: " SC-Domain:Example.COM ",
      ga4_property_id: " 0123456789 ",
    });
    expect(site).toMatchObject({
      name: "Blog",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "0123456789",
    });
    expect(site.id).toMatch(/^site_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(site.created_at).toBe(site.updated_at);
    const res = await send(`/api/v1/sites/${site.id}`, { cookies: memberCookies });
    expect(await res.json()).toEqual(site);
  });

  it("keeps a non-default port and stores a URL prefix with its trailing slash", async () => {
    const site = await created({ name: "Dev", url: "http://localhost:8787/x", gsc_property: "https://example.com" });
    expect(site.url).toBe("http://localhost:8787");
    expect(site.gsc_property).toBe("https://example.com/");
    const prefix = await created({ name: "Docs", url: "https://docs.example.com", gsc_property: "https://example.com/docs/" });
    expect(prefix.gsc_property).toBe("https://example.com/docs/");
  });

  it("stores missing, null and blank properties as null", async () => {
    const a = await created({ name: "A", url: "https://a.example.com" });
    const b = await created({ name: "B", url: "https://b.example.com", gsc_property: null, ga4_property_id: null });
    const c = await created({ name: "C", url: "https://c.example.com", gsc_property: "  ", ga4_property_id: "" });
    for (const site of [a, b, c]) {
      expect(site.gsc_property).toBeNull();
      expect(site.ga4_property_id).toBeNull();
    }
  });

  it("registers http and https of the same host as two sites", async () => {
    await created({ name: "A", url: "https://example.com" });
    await created({ name: "B", url: "http://example.com" });
    expect(await countTable("sites")).toBe(2);
  });

  it("returns 409 url_conflict for a URL with the same origin", async () => {
    await created({ name: "A", url: "https://example.com/a" });
    await expectError(
      await createRequest({ name: "B", url: "https://EXAMPLE.com/b" }),
      409,
      "url_conflict",
      "この URL のサイトは登録済みです",
    );
  });

  it("returns 409 limit_exceeded at 100 sites, also for a duplicate URL", async () => {
    for (let i = 0; i < 100; i++) await createSite({ url: `https://s${i}.example.com` });
    await expectError(
      await createRequest({ name: "New", url: "https://new.example.com" }),
      409,
      "limit_exceeded",
      "サイトは 100 件まで登録できます",
    );
    await expectError(await createRequest({ name: "Dup", url: "https://s0.example.com" }), 409, "limit_exceeded");
    expect(await countTable("sites")).toBe(100);
  });

  it("creates the 100th site", async () => {
    for (let i = 0; i < 99; i++) await createSite({ url: `https://s${i}.example.com` });
    await created({ name: "Last", url: "https://last.example.com" });
    expect(await countTable("sites")).toBe(100);
  });

  it("rejects a body that is not a JSON object", async () => {
    for (const json of ["not json", "[]", "null", "1"]) {
      await expectError(await createRequest(json), 400, "invalid_body");
    }
  });

  it("rejects unknown fields first", async () => {
    await expectError(
      await createRequest({ name: "", url: "x", extra: 1 }),
      400,
      "unknown_field",
      "未知の項目があります: extra",
    );
  });

  it("validates the name before the URL, the URL before the properties", async () => {
    await expectError(await createRequest({ url: "x", gsc_property: 1 }), 400, "invalid_name");
    await expectError(await createRequest({ name: "A", url: "x", gsc_property: 1 }), 400, "invalid_url");
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", gsc_property: 1, ga4_property_id: 1 }),
      400,
      "invalid_gsc_property",
    );
  });

  it.each([[undefined], [null], [1], [""], ["   "], ["a\u0007b"], ["a".repeat(101)]])("rejects the name %j", async (name) => {
    await expectError(
      await createRequest({ name, url: "https://a.example.com" }),
      400,
      "invalid_name",
      "名前は制御文字を含まない 1〜100 文字にしてください",
    );
  });

  it("accepts a name of 100 code points", async () => {
    const site = await created({ name: "😀".repeat(100), url: "https://a.example.com" });
    expect(site.name).toBe("😀".repeat(100));
  });

  it.each([
    [undefined],
    [null],
    [1],
    [""],
    ["example.com"],
    ["ftp://example.com"],
    ["javascript:alert(1)"],
    ["https://user:pass@example.com"],
    ["https://user@example.com"],
    [`https://example.com/${"a".repeat(2049 - "https://example.com/".length)}`],
  ])("rejects the URL %j", async (url) => {
    await expectError(
      await createRequest({ name: "A", url }),
      400,
      "invalid_url",
      "URL は http または https で始まる正しい形式にしてください",
    );
  });

  it("accepts a URL of 2048 characters", async () => {
    const url = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
    expect(url).toHaveLength(2048);
    expect((await created({ name: "A", url })).url).toBe("https://example.com");
  });

  it.each([
    [1],
    ["sc-domain:"],
    ["sc-domain:example"],
    ["sc-domain:-example.com"],
    ["sc-domain:exa_mple.com"],
    ["sc-domain:https://example.com"],
    [`sc-domain:${"a".repeat(250)}.com`],
    ["example.com"],
    ["ftp://example.com/"],
    ["https://example.com/docs"],
    ["https://example.com/?q=1"],
    ["https://example.com/#top"],
    ["https://user:pass@example.com/"],
  ])("rejects the Search Console property %j", async (gscProperty) => {
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", gsc_property: gscProperty }),
      400,
      "invalid_gsc_property",
      "Search Console のプロパティは sc-domain:example.com か https://example.com/ の形式にしてください",
    );
  });

  it.each([[1], ["12a"], ["G-12345"], ["1".repeat(21)], ["-1"]])("rejects the GA4 property ID %j", async (id) => {
    await expectError(
      await createRequest({ name: "A", url: "https://a.example.com", ga4_property_id: id }),
      400,
      "invalid_ga4_property",
      "GA4 のプロパティ ID は数字だけで入力してください",
    );
  });

  it("accepts a GA4 property ID of 20 digits", async () => {
    const site = await created({ name: "A", url: "https://a.example.com", ga4_property_id: "9".repeat(20) });
    expect(site.ga4_property_id).toBe("9".repeat(20));
  });
});

describe("GET /api/v1/sites/:id", () => {
  it("returns 404 not_found for a missing site or an ID of another form", async () => {
    for (const id of [MISSING_ID, "site_bad", "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V"]) {
      await expectError(
        await send(`/api/v1/sites/${id}`, { cookies: memberCookies }),
        404,
        "not_found",
        "サイトが見つかりません",
      );
    }
  });
});

describe("PATCH /api/v1/sites/:id", () => {
  it("changes only the given items", async () => {
    const site = await created({
      name: "Blog",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "123",
    });
    const res = await updateRequest(site.id, { name: " Blog 2 " });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Site;
    expect(updated).toMatchObject({
      id: site.id,
      name: "Blog 2",
      url: "https://blog.example.com",
      gsc_property: "sc-domain:example.com",
      ga4_property_id: "123",
      created_at: site.created_at,
    });
    expect(updated.updated_at).toBeGreaterThanOrEqual(site.updated_at);
  });

  it("changes the URL and clears the properties", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com", gsc_property: "sc-domain:example.com", ga4_property_id: "1" });
    const res = await updateRequest(site.id, { url: "https://new.example.com/path", gsc_property: null, ga4_property_id: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "https://new.example.com", gsc_property: null, ga4_property_id: null });
  });

  it("accepts the site's own URL", async () => {
    const site = await created({ name: "Blog", url: "https://blog.example.com" });
    expect((await updateRequest(site.id, { url: "https://blog.example.com/" })).status).toBe(200);
  });

  it("returns 409 url_conflict for the URL of another site", async () => {
    await created({ name: "A", url: "https://a.example.com" });
    const b = await created({ name: "B", url: "https://b.example.com" });
    await expectError(await updateRequest(b.id, { url: "https://a.example.com" }), 409, "url_conflict");
  });

  it("returns 400 invalid_request for an empty object", async () => {
    const site = await createSite();
    await expectError(await updateRequest(site.id, {}), 400, "invalid_request", "変更する項目を指定してください");
  });

  it("validates in order: unknown fields, then the items", async () => {
    const site = await createSite();
    await expectError(await updateRequest(site.id, { id: "x" }), 400, "unknown_field", "未知の項目があります: id");
    await expectError(await updateRequest(site.id, { name: "", url: "x" }), 400, "invalid_name");
    await expectError(await updateRequest(site.id, { url: "x", gsc_property: 1 }), 400, "invalid_url");
    await expectError(await updateRequest(site.id, { gsc_property: 1, ga4_property_id: 1 }), 400, "invalid_gsc_property");
    await expectError(await updateRequest(site.id, { ga4_property_id: 1 }), 400, "invalid_ga4_property");
    await expectError(await updateRequest(site.id, { name: null }), 400, "invalid_name");
    await expectError(await updateRequest(site.id, { url: null }), 400, "invalid_url");
  });

  it("returns 404 not_found for a missing site or an ID of another form", async () => {
    for (const id of [MISSING_ID, "site_bad"]) {
      await expectError(await updateRequest(id, { name: "A" }), 404, "not_found", "サイトが見つかりません");
    }
  });
});

describe("DELETE /api/v1/sites/:id", () => {
  it("deletes the site", async () => {
    const site = await createSite();
    const other = await createSite();
    const res = await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(204);
    expect(await countTable("sites")).toBe(1);
    const left = await env.DB.prepare("SELECT id FROM sites").first<{ id: string }>();
    expect(left?.id).toBe(other.id);
  });

  it("returns 404 not_found for a missing site, a deleted one or an ID of another form", async () => {
    const site = await createSite();
    expect((await send(`/api/v1/sites/${site.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
    for (const id of [site.id, MISSING_ID, "site_bad"]) {
      await expectError(
        await send(`/api/v1/sites/${id}`, { method: "DELETE", cookies: memberCookies }),
        404,
        "not_found",
        "サイトが見つかりません",
      );
    }
  });
});
