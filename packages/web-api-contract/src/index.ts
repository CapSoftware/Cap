import { z } from "zod";
import { initContract } from "@ts-rest/core";

import desktop from "./desktop";

export const contract = initContract().router({
  desktop,
  video: initContract().router({
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

export const licenseContract = initContract().router({
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
