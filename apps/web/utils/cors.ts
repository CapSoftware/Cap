export const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export function getCorsHeaders(origin: string | null, originalOrigin: string) {
  return {
    "Access-Control-Allow-Origin":
      origin && allowedOrigins.includes(origin)
        ? origin
        : allowedOrigins.includes(originalOrigin)
        ? originalOrigin
        : "null",
    "Access-Control-Allow-Credentials": "true",
  };
}

export function getOptionsHeaders(origin: string | null, originalOrigin: string, methods = "GET, OPTIONS") {
  return {
    ...getCorsHeaders(origin, originalOrigin),
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, sentry-trace, baggage",
  };
} 