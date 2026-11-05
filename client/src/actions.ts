import type {
  CreateSiteRequest,
  CreateUserRequest,
  Site,
  SyncRequest,
  SyncResponse,
  UpdateSiteRequest,
  User,
} from "../../src/api/types";
import { LoginRequiredError, responseErrorMessage, unexpectedResponseMessage } from "./api";
import type { ApiClient } from "./load";
import { isValidId } from "./router";

// The outcomes shared by the actions below.
type SendFailure =
  | { kind: "error"; message: string }
  // The request did not get a response, so it may have succeeded on the server.
  | { kind: "unknown" }
  // Login is required and the move to the login page has started.
  | { kind: "redirecting" };

// Sends a request. A rejection becomes the failure to return; never rejects.
async function send<R>(call: () => Promise<R>): Promise<{ kind: "response"; res: R } | SendFailure> {
  try {
    return { kind: "response", res: await call() };
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "unknown" };
  }
}

// The outcome of the actions on a resource. Errors of the request (400), of the permissions (403) and of
// the state of the resource (409) are shown with the server's message.
type ResourceActionResult =
  | { kind: "ok" }
  // The resource is missing or not accessible.
  | { kind: "notFound" }
  | SendFailure;

async function resourceActionResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<ResourceActionResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type CreateUserResult = { kind: "ok"; user: User } | SendFailure;

// Creates a user with a password (password mode only). Admins only. Errors, including email_taken (409) and
// the 404 of OIDC mode, are shown with the server's message. Never rejects.
export async function createUser(client: ApiClient, input: CreateUserRequest): Promise<CreateUserResult> {
  const sent = await send(() => client.api.v1.users.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", user: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the actions on a user. notFound means the user is gone; other errors (400, 403, and 409
// last_admin) are shown with the server's message.
export type UserActionResult = ResourceActionResult;

// hc() puts params into the URL without encoding them, so an invalid ID is not sent.
const INVALID_USER_ID: UserActionResult = { kind: "error", message: "ユーザーが見つかりません" };

// Changes the role of a user. Admins only. Never rejects.
export async function changeUserRole(client: ApiClient, userId: string, role: User["role"]): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].$patch({ param: { id: userId }, json: { role } })),
  );
}

// Sets a new password for a user and ends their sessions and MCP connections (password mode only). Admins only. In OIDC mode the server also answers 404 with the same code, which cannot be told apart from a
// missing user; it only happens if the mode changed after the screen loaded, and the reload that follows
// hides the button. Never rejects.
export async function resetUserPassword(client: ApiClient, userId: string, password: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].password.$post({ param: { id: userId }, json: { password } })),
  );
}

// Ends the sessions and MCP connections of a user. Admins only. Never rejects.
export async function revokeUserSessions(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"]["revoke-sessions"].$post({ param: { id: userId } })),
  );
}

// Deletes a user and their sessions. The sites stay. This cannot be undone. Admins only. Never rejects.
export async function deleteUser(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(await send(() => client.api.v1.users[":id"].$delete({ param: { id: userId } })));
}

// Reads the JSON body of an ok response; an error if it is not JSON.
async function okJson<T>(res: { status: number; json(): Promise<T> }): Promise<{ kind: "ok"; value: T } | SendFailure> {
  try {
    return { kind: "ok", value: await res.json() };
  } catch {
    return { kind: "error", message: unexpectedResponseMessage(res.status) };
  }
}

export type SiteResult = { kind: "ok"; site: Site } | { kind: "notFound" } | SendFailure;

async function siteResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<SiteResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson(res as { status: number; json(): Promise<Site> });
    return body.kind === "ok" ? { kind: "ok", site: body.value } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Registers a site. Errors, including url_conflict and limit_exceeded (409), are shown with the server's message.
// Never rejects.
export async function createSite(client: ApiClient, input: CreateSiteRequest): Promise<SiteResult> {
  return siteResult(await send(() => client.api.v1.sites.$post({ json: input })));
}

const INVALID_SITE_ID = { kind: "error", message: "サイトが見つかりません" } as const;

// Changes the given items of a site. Errors, including url_conflict (409), are shown with the server's message.
// Never rejects.
export async function updateSite(client: ApiClient, siteId: string, input: UpdateSiteRequest): Promise<SiteResult> {
  if (!isValidId(siteId)) return INVALID_SITE_ID;
  return siteResult(await send(() => client.api.v1.sites[":id"].$patch({ param: { id: siteId }, json: input })));
}

// The outcome of deleting a site. notFound means it is gone.
export type SiteActionResult = ResourceActionResult;

// Deletes a site. This cannot be undone. Never rejects.
export async function deleteSite(client: ApiClient, siteId: string): Promise<SiteActionResult> {
  if (!isValidId(siteId)) return INVALID_SITE_ID;
  return resourceActionResult(await send(() => client.api.v1.sites[":id"].$delete({ param: { id: siteId } })));
}

export type SyncResult = { kind: "ok"; result: SyncResponse } | { kind: "notFound" } | SendFailure;

// Asks for the import of the days from start_date to end_date. Errors, including not_configured and
// google_not_configured (409) and temporarily_unavailable (503), are shown with the server's message. Never rejects.
export async function requestSync(client: ApiClient, siteId: string, input: SyncRequest): Promise<SyncResult> {
  if (!isValidId(siteId)) return INVALID_SITE_ID;
  const sent = await send(() => client.api.v1.sites[":id"].sync.$post({ param: { id: siteId }, json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson(res as { status: number; json(): Promise<SyncResponse> });
    return body.kind === "ok" ? { kind: "ok", result: body.value } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}
