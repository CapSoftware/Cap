import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";

const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, sentry-trace, baggage",
    },
  });
}

export async function POST(req: NextRequest) {

  const token = req.headers.get("authorization")?.split(" ")[1];
  if (token) {
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  }

  const user = await getCurrentUser();
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;


  if (!user) {
    return new Response(JSON.stringify({ error: "User not authenticated" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  const formData = await req.formData();
  const feedbackText = formData.get("feedback") as string;


  if (!feedbackText) {
    return new Response(JSON.stringify({ error: "Feedback text is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  try {
    // Send feedback to Discord channel
    const discordWebhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
    if (!discordWebhookUrl) {
      throw new Error("Discord webhook URL is not configured");
    }

    const response = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `New feedback from ${user.email}:\n${feedbackText}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send feedback to Discord: ${response.statusText}`);
    }

    return new Response(JSON.stringify({ success: true, message: "Feedback submitted successfully" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to submit feedback" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }
}