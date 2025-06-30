import { z } from "zod";
import desktop from "./desktop";
import { c } from "./util";

export const contract = c.router({
  desktop,
  video: c.router({
    getTranscribeStatus: {
      method: "GET",
      path: "/video/transcribe/status",
      query: z.object({ videoId: z.string() }),
      responses: {
        200: z.object({
          transcriptionStatus: z
            .custom<"PROCESSING" | "COMPLETE" | "ERROR">()
            .nullable(),
        }),
      },
    },
    delete: {
      method: "DELETE",
      path: "/video/delete",
      query: z.object({ videoId: z.string() }),
      responses: { 200: z.unknown() },
    },
    getAnalytics: {
      method: "GET",
      path: "/video/analytics",
      query: z.object({ videoId: z.string() }),
      responses: {
        200: z.object({ count: z.number() }),
      },
    },
  }),
});

export const orgCustomDomainContract = c.router({
  getOrgCustomDomain: {
    method: "GET",
    path: "/org-custom-domain",
    headers: z.object({ authorization: z.string() }),
    responses: {
      200: z.object({
        custom_domain: z.string().nullable(),
        domain_verified: z.boolean().nullable(),
      }),
      500: z.object({
        message: z.string(),
      }),
    },
  },
});

export const licenseContract = c.router({
  activateCommercialLicense: {
    method: "POST",
    path: "/commercial/activate",
    headers: z.object({ licensekey: z.string(), instanceid: z.string() }),
    body: z.object({ reset: z.boolean().optional() }),
    responses: {
      200: z.object({
        message: z.string(),
        expiryDate: z.number().optional(),
        refresh: z.number(),
      }),
      403: z.object({ message: z.string() }),
    },
  },
  createCommercialCheckoutUrl: {
    method: "POST",
    path: "/commercial/checkout",
    body: z.object({
      type: z.enum(["yearly", "lifetime"]),
      quantity: z.number().min(1).max(100).optional(),
    }),
    responses: {
      200: z.object({ url: z.string() }),
      500: z.object({ message: z.string() }),
    },
  },
});
