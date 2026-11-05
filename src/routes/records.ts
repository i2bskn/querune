import { Hono } from "hono";
import type { UpdateRecordRequest } from "../api/types";
import { apiError, clock } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import type { AppEnv } from "../env";
import { recordNotFound } from "../records/common";
import { deleteRecord, findRecord, updateRecord } from "../records/records";
import { checkRecordBody, type RecordInput } from "../records/validate";
import { failureResponse, recordsJsonBody } from "./site-content";

const updateRecordBody = recordsJsonBody<UpdateRecordRequest, Partial<RecordInput>>((body) =>
  checkRecordBody(body, false),
);

// The records by ID. Every signed-in user can read, change and delete them. The list and the creation are under
// /api/v1/sites/:id/records.
const recordsApi = new Hono<AppEnv>()
  .use("*", requireUser)
  .get("/:id", async (c) => {
    const record = await findRecord(c.get("db"), c.req.param("id"));
    if (!record) return apiError(c, 404, "not_found", recordNotFound);
    return c.json(record, 200);
  })
  .patch("/:id", updateRecordBody, async (c) => {
    const result = await updateRecord(c.get("db"), c.req.param("id"), c.req.valid("json"), clock.now());
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.value.record, 200);
  })
  .delete("/:id", async (c) => {
    if (!(await deleteRecord(c.get("db").$client, c.req.param("id")))) {
      return apiError(c, 404, "not_found", recordNotFound);
    }
    return c.body(null, 204);
  });

export default recordsApi;
