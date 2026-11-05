import { Hono } from "hono";
import type { AppEnv } from "./env";
import {
  apiError,
  describeError,
  isJsonPath,
  loadConfigMiddleware,
  sameOrigin,
  securityHeaders,
  unifyHost,
} from "./auth/middleware";
import auth from "./routes/auth";
import articlesApi from "./routes/articles";
import authorize from "./routes/authorize";
import googleApi from "./routes/google";
import me from "./routes/me";
import recordsApi from "./routes/records";
import sitesApi from "./routes/sites";
import usersApi from "./routes/users";
import { ErrorPage } from "./views/error";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", loadConfigMiddleware);
app.use("*", unifyHost);
// Cookie-authenticated routes only. /mcp and the OAuth endpoints served by OAuthProvider must not use sameOrigin.
app.use("/auth/*", sameOrigin);
app.use("/api/v1/*", sameOrigin);
app.use("/authorize", sameOrigin);

// "/" and other paths not listed in run_worker_first in wrangler.jsonc are served by the static
// assets (the SPA) and never reach the Worker. When adding a top-level path here, add it to
// run_worker_first as well.
app.route("/auth", auth);
app.route("/authorize", authorize);
const apiRoutes = app
  .route("/api/v1/me", me)
  .route("/api/v1/users", usersApi)
  .route("/api/v1/sites", sitesApi)
  .route("/api/v1/google", googleApi)
  .route("/api/v1/articles", articlesApi)
  .route("/api/v1/records", recordsApi);

// Types for hc<AppType>(). Only /api/v1/* is included.
export type AppType = typeof apiRoutes;

app.notFound((c) => {
  if (isJsonPath(c.req.path)) return apiError(c, 404, "not_found", "見つかりません");
  return c.html(ErrorPage({ message: "ページが見つかりません" }), 404);
});

app.onError((error, c) => {
  console.error("unhandled error", describeError(error));
  if (isJsonPath(c.req.path)) return apiError(c, 500, "internal_error", "サーバーでエラーが発生しました");
  return c.html(ErrorPage({ message: "サーバーでエラーが発生しました" }), 500);
});

export default app;
