import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const CHANGELOG = z.object({
  metadata: z.object({
    title: z.string(),
    app: z.string(),
    publishedAt: z.string(),
    version: z.string(),
    image: z.string().optional(),
  }),
  content: z.string(),
  slug: z.number(),
});

const publicContract = c.router({
  getChangelogPosts: {
    method: "GET",
    path: "/changelog",
    responses: {
      200: z.array(CHANGELOG),
    },
  },
  getChangelogStatus: {
    method: "GET",
    path: "/changelog/status",
    responses: {
      200: z.object({ hasUpdate: z.boolean() }),
    },
  },
});

const protectedContract = c.router(
  {
    submitDesktopFeedback: {
      method: "POST",
      path: "/desktop/feedback",
      contentType: "application/x-www-form-urlencoded",
      body: z.object({ feedback: z.string() }),
      responses: {
        200: z.object({ success: z.boolean() }),
      },
    },
    getUserPlan: {
      method: "GET",
      path: "/desktop/plan",
      responses: {
        200: z.object({ upgraded: z.boolean() }),
      },
    },
  },
  {
    baseHeaders: z.object({ authorization: z.string().optional() }),
    commonResponses: { 401: z.object({ error: z.string().or(z.boolean()) }) },
  }
);

export const contract = c.router({
  public: publicContract,
  protected: protectedContract,
});
