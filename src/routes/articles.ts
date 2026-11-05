import { Hono } from "hono";
import type { UpdateArticleRequest } from "../api/types";
import { apiError, clock } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import type { AppEnv } from "../env";
import { deleteArticle, findArticle, updateArticle } from "../records/articles";
import { articleNotFound } from "../records/common";
import { checkArticleBody, type ArticleInput } from "../records/validate";
import { failureResponse, recordsJsonBody } from "./site-content";

const updateArticleBody = recordsJsonBody<UpdateArticleRequest, Partial<ArticleInput>>((body) =>
  checkArticleBody(body, false),
);

// The articles by ID. Every signed-in user can read, change and delete them. The list and the creation are under
// /api/v1/sites/:id/articles.
const articlesApi = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/:id", async (c) => {
    const article = await findArticle(c.get("db"), c.req.param("id"));
    if (!article) return apiError(c, 404, "not_found", articleNotFound);
    return c.json(article, 200);
  })
  .patch("/:id", updateArticleBody, async (c) => {
    const result = await updateArticle(c.get("db"), c.req.param("id"), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value.article, 200);
  })
  .delete("/:id", async (c) => {
    if (!(await deleteArticle(c.get("db"), c.req.param("id")))) return apiError(c, 404, "not_found", articleNotFound);
    return c.body(null, 204);
  });

export default articlesApi;
