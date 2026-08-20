import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { checkoutIssueSchema, upsertIssueDocumentSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/responsible-user-denial-run-outcomes.js", () => ({
  recordResponsibleUserDenialOnActiveRun: vi.fn(async () => null),
}));

/**
 * Regression guard for PAP-21: request bodies rejected by the shared Zod
 * validators must surface as HTTP 400 client errors, never HTTP 500.
 *
 * The schemas live in `@paperclipai/shared` while the error handler lives in
 * the server package, so a monorepo layout that resolves two Zod module
 * instances breaks `instanceof ZodError` and silently downgrades these routes
 * to "Internal server error". These tests exercise that exact cross-package
 * seam with the real schemas and the real error handler.
 */
function paths(details: unknown) {
  return (details as Array<{ path: unknown[] }>).map((issue) => issue.path.join("."));
}

describe("issue route validation errors map to 400", () => {
  it("rejects an empty POST /checkout body with 400 and names the missing fields", async () => {
    const app = express();
    app.use(express.json());
    app.post("/issues/:id/checkout", validate(checkoutIssueSchema), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).post("/issues/issue-1/checkout").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(paths(res.body.details)).toEqual(
      expect.arrayContaining(["agentId", "expectedStatuses"]),
    );
  });

  it("accepts a well-formed POST /checkout body", async () => {
    const app = express();
    app.use(express.json());
    app.post("/issues/:id/checkout", validate(checkoutIssueSchema), (req, res) => {
      res.json({ agentId: req.body.agentId, expectedStatuses: req.body.expectedStatuses });
    });
    app.use(errorHandler);

    const res = await request(app)
      .post("/issues/issue-1/checkout")
      .send({
        agentId: "33333333-3333-4333-8333-333333333333",
        expectedStatuses: ["todo", "in_progress"],
      });

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("rejects an invalid PUT /documents/:key body with 400 from an async handler", async () => {
    // The real route parses inside an async handler, so the rejected promise
    // has to reach the error handler as a 400 rather than an unhandled 500.
    const app = express();
    app.use(express.json());
    app.put("/issues/:id/documents/:key", async (req, res) => {
      const input = upsertIssueDocumentSchema.parse(req.body);
      res.status(201).json(input);
    });
    app.use(errorHandler);

    const res = await request(app)
      .put("/issues/issue-1/documents/plan")
      .send({ body: "no format supplied" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(paths(res.body.details)).toContain("format");
  });

  it("accepts a well-formed PUT /documents/:key body", async () => {
    const app = express();
    app.use(express.json());
    app.put("/issues/:id/documents/:key", async (req, res) => {
      const input = upsertIssueDocumentSchema.parse(req.body);
      res.status(201).json(input);
    });
    app.use(errorHandler);

    const res = await request(app)
      .put("/issues/issue-1/documents/plan")
      .send({ format: "markdown", body: "# Plan", title: "Plan" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ format: "markdown", body: "# Plan", title: "Plan" });
  });
});
