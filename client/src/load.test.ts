import { describe, expect, it, vi } from "vitest";
import type {
  Article,
  ArticleSummary,
  GoogleStatus,
  RecordList,
  Site,
  SiteRecord,
  SyncStatus,
  TagList,
  User,
} from "../../src/api/types";
import { createApiClient, createApiFetch } from "./api";
import {
  loadArticleDetail,
  loadArticlesView,
  loadMe,
  loadRecordDetail,
  loadRecordPage,
  loadRecordsView,
  loadSiteDetail,
  loadSites,
  loadSyncPanel,
  loadUsersView,
} from "./load";

type Reply = () => Response;

function json(code: number, body: unknown): Reply {
  return () => Response.json(body, { status: code });
}

function apiError(code: number, message: string): Reply {
  return json(code, { error: { code: "error", message } });
}

// fetch that answers each URL from its own queue, in order. /auth/refresh answers 204 unless given.
function setup(routes: Record<string, Reply[]>) {
  const queues = new Map(Object.entries(routes).map(([url, replies]) => [url, [...replies]]));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    const reply = queues.get(url)?.shift() ?? (url === "/auth/refresh" ? () => new Response(null, { status: 204 }) : null);
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  const calls = (url: string) => fetch.mock.calls.filter(([input]) => String(input) === url).length;
  return { client, fetch, redirectToLogin, calls };
}

const unauthorized = apiError(401, "ログインしてください");

describe("loadMe", () => {
  it("returns the signed-in user", async () => {
    const user: User = { id: "u1", email: "a@example.com", name: null, role: "member", created_at: 1, last_login_at: null };
    const { client } = setup({ "/api/v1/me": [json(200, user)] });
    expect(await loadMe(client)).toEqual({ kind: "ready", data: user });
  });

  it("is an error on 404", async () => {
    const { client } = setup({ "/api/v1/me": [apiError(404, "見つかりません")] });
    expect(await loadMe(client)).toEqual({ kind: "error", message: "見つかりません" });
  });
});

describe("loadUsersView", () => {
  const USER: User = {
    id: "u1",
    email: "a@example.com",
    name: null,
    role: "admin",
    created_at: 1,
    last_login_at: null,
  };

  it("shows the users and the auth mode", async () => {
    const { client } = setup({ "/api/v1/users": [json(200, { users: [USER], auth_mode: "oidc" })] });
    expect(await loadUsersView(client)).toEqual({ kind: "ready", data: { users: [USER], authMode: "oidc" } });
  });

  it("is an error with the API message on 403", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(403, "管理者の権限が必要です")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "管理者の権限が必要です" });
  });

  it("is an error on 404", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(404, "見つかりません")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "見つかりません" });
  });

  it("moves to the login page when the list stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/users": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadUsersView(client)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

const SITE: Site = {
  id: "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  name: "Blog",
  url: "https://blog.example.com",
  gsc_property: "sc-domain:example.com",
  ga4_property_id: null,
  created_at: 1,
  updated_at: 2,
};

describe("loadSites", () => {
  it("returns the sites", async () => {
    const { client } = setup({ "/api/v1/sites": [json(200, { sites: [SITE] })] });
    expect(await loadSites(client)).toEqual({ kind: "ready", data: [SITE] });
  });

  it("is an error with the API message, also on 404", async () => {
    const failing = setup({ "/api/v1/sites": [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadSites(failing.client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
    const missing = setup({ "/api/v1/sites": [apiError(404, "見つかりません")] });
    expect(await loadSites(missing.client)).toEqual({ kind: "error", message: "見つかりません" });
  });

  it("is an error when the connection fails", async () => {
    const { client } = setup({
      "/api/v1/sites": [
        () => {
          throw new TypeError("offline");
        },
      ],
    });
    expect(await loadSites(client)).toEqual({ kind: "error", message: "サーバーに接続できませんでした" });
  });

  it("moves to the login page when the list stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/sites": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadSites(client)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("loadSiteDetail", () => {
  it("returns the site", async () => {
    const { client } = setup({ [`/api/v1/sites/${SITE.id}`]: [json(200, SITE)] });
    expect(await loadSiteDetail(client, SITE.id)).toEqual({ kind: "ready", data: SITE });
  });

  it("is not found when the API answers 404", async () => {
    const { client } = setup({ [`/api/v1/sites/${SITE.id}`]: [apiError(404, "サイトが見つかりません")] });
    expect(await loadSiteDetail(client, SITE.id)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message otherwise", async () => {
    const { client } = setup({ [`/api/v1/sites/${SITE.id}`]: [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadSiteDetail(client, SITE.id)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is not found for an invalid ID without sending", async () => {
    const { client, fetch } = setup({});
    expect(await loadSiteDetail(client, "a/b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadSyncPanel", () => {
  const GOOGLE: GoogleStatus = { configured: true, client_email: "querune@project.iam.gserviceaccount.com", error: null };
  const STATUS: SyncStatus = { site_id: SITE.id, datasets: [] };
  const statusUrl = `/api/v1/sites/${SITE.id}/sync`;

  it("returns the service account and the import state", async () => {
    const { client } = setup({ "/api/v1/google": [json(200, GOOGLE)], [statusUrl]: [json(200, STATUS)] });
    expect(await loadSyncPanel(client, SITE.id)).toEqual({ kind: "ready", data: { google: GOOGLE, status: STATUS } });
  });

  it("is not found when the site is gone", async () => {
    const { client } = setup({
      "/api/v1/google": [json(200, GOOGLE)],
      [statusUrl]: [apiError(404, "サイトが見つかりません")],
    });
    expect(await loadSyncPanel(client, SITE.id)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message otherwise", async () => {
    const { client } = setup({
      "/api/v1/google": [apiError(500, "サーバーでエラーが発生しました")],
      [statusUrl]: [json(200, STATUS)],
    });
    expect(await loadSyncPanel(client, SITE.id)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is not found for an invalid ID without sending", async () => {
    const { client, fetch } = setup({});
    expect(await loadSyncPanel(client, "a/b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const ARTICLE: Article = {
  id: "art_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  site_id: SITE.id,
  title: "Guide",
  url: "https://blog.example.com/guide",
  published_on: "2026-10-01",
  tags: ["topic:ai"],
  note: "memo",
  created_at: 1,
  updated_at: 2,
};
const { note: _note, ...SUMMARY } = ARTICLE;
const ARTICLE_SUMMARY: ArticleSummary = SUMMARY;
const TAGS: TagList = { tags: [{ tag: "topic:ai", articles: 1, records: 0 }], truncated: false };
const RECORD: SiteRecord = {
  id: "rec_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  site_id: SITE.id,
  kind: "action",
  status: "done",
  title: "Rewrite",
  date: "2026-10-02",
  period_start: null,
  period_end: null,
  tags: [],
  content: "",
  articles: [{ id: ARTICLE.id, title: "Guide", url: ARTICLE.url }],
  created_at: 1,
  updated_at: 2,
};
const RECORD_LIST: RecordList = {
  records: [{ ...RECORD, articles: [{ id: ARTICLE.id, title: "Guide" }] }].map(({ content: _content, ...rest }) => rest),
  next_offset: null,
};

describe("loadArticlesView", () => {
  const siteUrl = `/api/v1/sites/${SITE.id}`;

  it("returns the site, the articles filtered by the tag and the tags", async () => {
    const { client } = setup({
      [siteUrl]: [json(200, SITE)],
      [`${siteUrl}/articles?tag=topic%3Aai`]: [json(200, { articles: [ARTICLE_SUMMARY] })],
      [`${siteUrl}/tags`]: [json(200, TAGS)],
    });
    expect(await loadArticlesView(client, SITE.id, "topic:ai")).toEqual({
      kind: "ready",
      data: { site: SITE, articles: [ARTICLE_SUMMARY], tags: TAGS },
    });
  });

  it("is not found when the site is gone, and without sending for an invalid ID", async () => {
    const { client } = setup({
      [siteUrl]: [apiError(404, "サイトが見つかりません")],
      [`${siteUrl}/articles`]: [apiError(404, "サイトが見つかりません")],
      [`${siteUrl}/tags`]: [apiError(404, "サイトが見つかりません")],
    });
    expect(await loadArticlesView(client, SITE.id, null)).toEqual({ kind: "notFound" });
    const invalid = setup({});
    expect(await loadArticlesView(invalid.client, "a/b", null)).toEqual({ kind: "notFound" });
    expect(invalid.fetch).not.toHaveBeenCalled();
  });
});

describe("loadArticleDetail", () => {
  it("returns the article and its site", async () => {
    const { client } = setup({
      [`/api/v1/articles/${ARTICLE.id}`]: [json(200, ARTICLE)],
      [`/api/v1/sites/${SITE.id}`]: [json(200, SITE)],
    });
    expect(await loadArticleDetail(client, ARTICLE.id)).toEqual({ kind: "ready", data: { article: ARTICLE, site: SITE } });
  });

  it("is not found on 404", async () => {
    const { client } = setup({ [`/api/v1/articles/${ARTICLE.id}`]: [apiError(404, "記事が見つかりません")] });
    expect(await loadArticleDetail(client, ARTICLE.id)).toEqual({ kind: "notFound" });
  });
});

describe("loadRecordPage", () => {
  it("sends the query and returns the page", async () => {
    const { client } = setup({
      [`/api/v1/sites/${SITE.id}/records?article_id=${ARTICLE.id}&limit=50&offset=50`]: [json(200, RECORD_LIST)],
    });
    expect(await loadRecordPage(client, SITE.id, { article_id: ARTICLE.id, limit: "50", offset: "50" })).toEqual({
      kind: "ready",
      data: RECORD_LIST,
    });
  });

  it("is an error with the API message on 400", async () => {
    const { client } = setup({ [`/api/v1/sites/${SITE.id}/records?kind=x`]: [apiError(400, "絞り込みの条件 kind が正しくありません")] });
    expect(await loadRecordPage(client, SITE.id, { kind: "x" })).toEqual({
      kind: "error",
      message: "絞り込みの条件 kind が正しくありません",
    });
  });
});

describe("loadRecordsView", () => {
  it("returns the site, the first page, the tags and the articles", async () => {
    const siteUrl = `/api/v1/sites/${SITE.id}`;
    const { client } = setup({
      [siteUrl]: [json(200, SITE)],
      [`${siteUrl}/records?kind=action`]: [json(200, RECORD_LIST)],
      [`${siteUrl}/tags`]: [json(200, TAGS)],
      [`${siteUrl}/articles`]: [json(200, { articles: [ARTICLE_SUMMARY] })],
    });
    expect(await loadRecordsView(client, SITE.id, { kind: "action" })).toEqual({
      kind: "ready",
      data: { site: SITE, records: RECORD_LIST, tags: TAGS, articles: [ARTICLE_SUMMARY] },
    });
  });
});

describe("loadRecordDetail", () => {
  it("returns the record, its site and the articles of the site", async () => {
    const { client } = setup({
      [`/api/v1/records/${RECORD.id}`]: [json(200, RECORD)],
      [`/api/v1/sites/${SITE.id}`]: [json(200, SITE)],
      [`/api/v1/sites/${SITE.id}/articles`]: [json(200, { articles: [ARTICLE_SUMMARY] })],
    });
    expect(await loadRecordDetail(client, RECORD.id)).toEqual({
      kind: "ready",
      data: { record: RECORD, site: SITE, articles: [ARTICLE_SUMMARY] },
    });
  });

  it("is not found on 404 and without sending for an invalid ID", async () => {
    const { client } = setup({ [`/api/v1/records/${RECORD.id}`]: [apiError(404, "記録が見つかりません")] });
    expect(await loadRecordDetail(client, RECORD.id)).toEqual({ kind: "notFound" });
    const invalid = setup({});
    expect(await loadRecordDetail(invalid.client, "a.b")).toEqual({ kind: "notFound" });
    expect(invalid.fetch).not.toHaveBeenCalled();
  });
});
