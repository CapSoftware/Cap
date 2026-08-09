import { buildEnv } from "@cap/env";
import { createRouteHandler } from "@openpanel/nextjs/server";

// First-party proxy for OpenPanel so ingestion (and the SDK script) is served
// from our own origin instead of a third-party host that ad blockers drop.
//
// The handler serves two paths under this route:
//   GET  /api/op/op1.js  -> proxies + caches the OpenPanel SDK script
//   POST /api/op/track   -> forwards the event payload to `apiUrl`
//
// `apiUrl` falls back to OpenPanel cloud inside the SDK when undefined, which
// is harmless: without NEXT_PUBLIC_OPENPANEL_CLIENT_ID nothing ever calls this.
const apiUrl = buildEnv.NEXT_PUBLIC_OPENPANEL_API_URL?.replace(/\/+$/, "");

// The handler's upstream fetches have no timeout; cap the function instead so
// a hung OpenPanel can't pin proxy invocations. Clients fire these keepalive
// and never await them, so the cap is invisible to users.
export const maxDuration = 10;

export const { GET, POST } = createRouteHandler(
	apiUrl ? { apiUrl } : undefined,
);
