import { useEffect, useState } from "react";
import type { Site, User, UserList } from "../../src/api/types";
import { isValidId } from "./router";
import {
  LoginRequiredError,
  type createApiClient,
  responseErrorMessage,
  unexpectedResponseMessage,
} from "./api";

export type ApiClient = ReturnType<typeof createApiClient>;

// The state of a screen that loads its own data.
export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // The API answered 404.
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "redirecting" };

export type Loaded<T> = Exclude<ViewState<T>, { kind: "loading" }>;

export const CONNECTION_ERROR = "サーバーに接続できませんでした";

type Result<T> =
  | { kind: "ok"; value: T }
  | { kind: "notFound"; message: string }
  // status is null when there was no response.
  | { kind: "error"; message: string; status: number | null }
  | { kind: "redirecting" };

type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

// The JSON body of the ok responses of an hc() call.
type OkJson<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

// Reads the JSON body of an ok response. null if it is not JSON.
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Calls the API and sorts the outcome. Never rejects.
async function request<R extends JsonResponse>(call: () => Promise<R>): Promise<Result<OkJson<R>>> {
  let res: R;
  try {
    res = await call();
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "error", message: CONNECTION_ERROR, status: null };
  }
  if (res.status === 404) return { kind: "notFound", message: await responseErrorMessage(res) };
  if (!res.ok) return { kind: "error", message: await responseErrorMessage(res), status: res.status };
  const body = await readJson(res);
  if (body === null) return { kind: "error", message: unexpectedResponseMessage(res.status), status: res.status };
  // res.ok is true here, so the body is one of the ok bodies.
  return { kind: "ok", value: body as OkJson<R> };
}

// Combines the results of the calls of one screen, at least one of which is not ok:
// redirecting > not found > error.
function failure(results: Result<unknown>[]): Loaded<never> {
  if (results.some((r) => r.kind === "redirecting")) return { kind: "redirecting" };
  if (results.some((r) => r.kind === "notFound")) return { kind: "notFound" };
  for (const r of results) {
    if (r.kind === "error") return { kind: "error", message: r.message };
  }
  throw new Error("failure() needs a result that is not ok");
}

export async function loadMe(client: ApiClient): Promise<Loaded<User>> {
  const me = await request(() => client.api.v1.me.$get());
  if (me.kind === "redirecting") return me;
  // There is no "not found" for the signed-in user; show it as an error.
  if (me.kind === "notFound" || me.kind === "error") return { kind: "error", message: me.message };
  return { kind: "ready", data: me.value };
}

export type UsersData = { users: User[]; authMode: UserList["auth_mode"] };

// Admins only. A 403 (a member opened the URL) is shown with the server's message.
export async function loadUsersView(client: ApiClient): Promise<Loaded<UsersData>> {
  const list = await request(() => client.api.v1.users.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: { users: list.value.users, authMode: list.value.auth_mode } };
}

// Every site, by name.
export async function loadSites(client: ApiClient): Promise<Loaded<Site[]>> {
  const list = await request(() => client.api.v1.sites.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value.sites };
}

// One site. A deleted site is not found.
export async function loadSiteDetail(client: ApiClient, id: string): Promise<Loaded<Site>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const site = await request(() => client.api.v1.sites[":id"].$get({ param: { id } }));
  if (site.kind !== "ok") return failure([site]);
  return { kind: "ready", data: site.value };
}

// Loads a screen's data while the component is mounted, and again when key changes or reload is called.
// A result that arrives after key has changed is dropped, so a previous screen does not overwrite the state.
export function useView<T>(load: () => Promise<Loaded<T>>, key: string): [ViewState<T>, () => void] {
  const [state, setState] = useState<ViewState<T>>({ kind: "loading" });
  // Incremented by reload to load again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // load is a new function on every render; key identifies what it loads.
  }, [key, attempt]);

  return [state, () => setAttempt((n) => n + 1)];
}
