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
