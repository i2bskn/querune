import { describe, expect, it, vi } from "vitest";
import type { Site, User } from "../../src/api/types";
import {
  changeUserRole,
  createSite,
  createUser,
  deleteSite,
  deleteUser,
  resetUserPassword,
  requestSync,
  revokeUserSessions,
  updateSite,
} from "./actions";
import { createApiClient, createApiFetch } from "./api";

// fetch that answers expectedUrl with reply. /auth/refresh answers 401 unless given, so a 401 ends at the login
// page.
function setup(reply: () => Response | Promise<Response>, refreshStatus: number, expectedUrl: string) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url === "/auth/refresh") return new Response(null, { status: refreshStatus });
    if (url !== expectedUrl) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  return { client, fetch, redirectToLogin };
}

function apiError(code: number, message: string): () => Response {
  return () => Response.json({ error: { code: "error", message } }, { status: code });
}

describe("createUser", () => {
  const url = "/api/v1/users";
  const input = { email: "new@example.com", name: null, password: "correct horse battery", role: "member" } as const;
  const USER: User = {
    id: "u2",
    email: "new@example.com",
    name: null,
    role: "member",
    created_at: 1,
    last_login_at: null,
  };

  it("sends the input and is ok with the user on 201", async () => {
    const { client, fetch } = setup(() => Response.json(USER, { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "ok", user: USER });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error when the created user is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it.each([
    [400, "パスワードは 12 文字以上 256 文字以下にしてください"],
    [404, "見つかりません"],
    [409, "このメールアドレスはすでに使われています"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "error", message });
  });

  it("is an error with a fixed message when the error is not JSON", async () => {
    const { client } = setup(() => new Response("Bad Gateway", { status: 502 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 502）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe.each([
  {
    name: "changeUserRole",
    url: "/api/v1/users/u1",
    method: "PATCH",
    body: { role: "member" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => changeUserRole(client, id, "member"),
    okStatus: 200,
  },
  {
    name: "resetUserPassword",
    url: "/api/v1/users/u1/password",
    method: "POST",
    body: { password: "a brand new password" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => resetUserPassword(client, id, "a brand new password"),
    okStatus: 204,
  },
  {
    name: "revokeUserSessions",
    url: "/api/v1/users/u1/revoke-sessions",
    method: "POST",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => revokeUserSessions(client, id),
    okStatus: 204,
  },
  {
    name: "deleteUser",
    url: "/api/v1/users/u1",
    method: "DELETE",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => deleteUser(client, id),
    okStatus: 204,
  },
])("$name", ({ url, method, body, call, okStatus }) => {
  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(
      () => (okStatus === 204 ? new Response(null, { status: 204 }) : Response.json({})),
      401,
      url,
    );
    expect(await call(client, "u1")).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe(method);
    if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ユーザーが見つかりません"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "自分自身は削除できません"],
    [403, "管理者の権限が必要です"],
    [409, "最後の管理者は削除できません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await call(client, "../spaces/s1")).toEqual({ kind: "error", message: "ユーザーが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const SITE_ID = "site_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
const SITE: Site = {
  id: SITE_ID,
  name: "Blog",
  url: "https://blog.example.com",
  gsc_property: null,
  ga4_property_id: "123",
  created_at: 1,
  updated_at: 1,
};

describe("createSite", () => {
  const url = "/api/v1/sites";
  const input = { name: "Blog", url: "https://blog.example.com", gsc_property: null, ga4_property_id: "123" };

  it("sends the input and is ok with the site on 201", async () => {
    const { client, fetch } = setup(() => Response.json(SITE, { status: 201 }), 401, url);
    expect(await createSite(client, input)).toEqual({ kind: "ok", site: SITE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it.each([
    [400, "URL は http または https で始まる正しい形式にしてください"],
    [409, "この URL のサイトは登録済みです"],
    [409, "サイトは 100 件まで登録できます"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createSite(client, input)).toEqual({ kind: "error", message });
  });

  it("is an error when the created site is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createSite(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createSite(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createSite(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe("updateSite", () => {
  const url = `/api/v1/sites/${SITE_ID}`;
  const input = { name: "Blog 2" };

  it("sends the input and is ok with the site on 200", async () => {
    const { client, fetch } = setup(() => Response.json({ ...SITE, name: "Blog 2" }), 401, url);
    expect(await updateSite(client, SITE_ID, input)).toEqual({ kind: "ok", site: { ...SITE, name: "Blog 2" } });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "サイトが見つかりません"), 401, url);
    expect(await updateSite(client, SITE_ID, input)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "この URL のサイトは登録済みです"), 401, url);
    expect(await updateSite(client, SITE_ID, input)).toEqual({ kind: "error", message: "この URL のサイトは登録済みです" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await updateSite(client, SITE_ID, input)).toEqual({ kind: "unknown" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json(SITE), 401, url);
    expect(await updateSite(client, "a/b", input)).toEqual({ kind: "error", message: "サイトが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("deleteSite", () => {
  const url = `/api/v1/sites/${SITE_ID}`;

  it("sends the request and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteSite(client, SITE_ID)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "サイトが見つかりません"), 401, url);
    expect(await deleteSite(client, SITE_ID)).toEqual({ kind: "notFound" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await deleteSite(client, SITE_ID)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await deleteSite(client, SITE_ID)).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteSite(client, "../users/u1")).toEqual({ kind: "error", message: "サイトが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("requestSync", () => {
  const url = `/api/v1/sites/${SITE_ID}/sync`;
  const input = { start_date: "2026-10-01", end_date: "2026-10-28" };

  it("sends the period and is ok with the counts on 202", async () => {
    const { client, fetch } = setup(() => Response.json({ queued: 84, days: 28 }, { status: 202 }), 401, url);
    expect(await requestSync(client, SITE_ID, input)).toEqual({ kind: "ok", result: { queued: 84, days: 28 } });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error with the server's message on 400, 409 and 503", async () => {
    for (const [status, message] of [
      [400, "一度に取り込める期間は 90 日までです"],
      [409, "サービスアカウントの鍵が設定されていません"],
      [503, "取り込みを依頼できませんでした。時間をおいてやり直してください"],
    ] as const) {
      const { client } = setup(apiError(status, message), 401, url);
      expect(await requestSync(client, SITE_ID, input)).toEqual({ kind: "error", message });
    }
  });

  it("is not found on 404, unknown when fetch rejects and redirecting when login is required", async () => {
    expect(await requestSync(setup(apiError(404, "サイトが見つかりません"), 401, url).client, SITE_ID, input)).toEqual({
      kind: "notFound",
    });
    expect(
      await requestSync(setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url).client, SITE_ID, input),
    ).toEqual({ kind: "unknown" });
    expect(await requestSync(setup(apiError(401, "ログインしてください"), 401, url).client, SITE_ID, input)).toEqual({
      kind: "redirecting",
    });
  });

  it("is an error when the response is not JSON", async () => {
    const { client } = setup(() => new Response("ok", { status: 202 }), 401, url);
    expect(await requestSync(client, SITE_ID, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 202）",
    });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 202 }), 401, url);
    expect(await requestSync(client, "../users/u1", input)).toEqual({ kind: "error", message: "サイトが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
