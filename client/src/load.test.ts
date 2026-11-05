import { describe, expect, it, vi } from "vitest";
import type { GoogleStatus, Site, SyncStatus, User } from "../../src/api/types";
import { createApiClient, createApiFetch } from "./api";
import { loadMe, loadSiteDetail, loadSites, loadSyncPanel, loadUsersView } from "./load";

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
