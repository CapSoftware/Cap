import { type NextRequest } from "next/server";

const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin") || null;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin) ? origin : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin") || null;

  return new Response("OK", {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin) ? origin : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
}
