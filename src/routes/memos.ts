import { Hono } from "hono";
import type { UpdateMemoRequest } from "../api/types";
import { apiError, clock } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import type { AppEnv } from "../env";
import { memoNotFound } from "../records/common";
import { deleteMemo, findMemo, updateMemo } from "../records/memos";
import { checkMemoBody, type MemoInput } from "../records/validate";
import { failureResponse, recordsJsonBody } from "./site-content";

const updateMemoBody = recordsJsonBody<UpdateMemoRequest, Partial<MemoInput>>((body) => checkMemoBody(body, false));

// The memos by ID. Every signed-in user can read, change and delete them. The list and the creation are under
// /api/v1/sites/:id/memos.
const memosApi = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/:id", async (c) => {
    const memo = await findMemo(c.get("db"), c.req.param("id"));
    if (!memo) return apiError(c, 404, "not_found", memoNotFound);
    return c.json(memo, 200);
  })
  .patch("/:id", updateMemoBody, async (c) => {
    const result = await updateMemo(c.get("db"), c.req.param("id"), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value.memo, 200);
  })
  .delete("/:id", async (c) => {
    if (!(await deleteMemo(c.get("db").$client, c.req.param("id")))) {
      return apiError(c, 404, "not_found", memoNotFound);
    }
    return c.body(null, 204);
  });

export default memosApi;
