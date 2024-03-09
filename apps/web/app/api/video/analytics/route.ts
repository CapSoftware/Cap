import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId");

  if (!videoId) {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const dubOptions = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.DUB_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  const analytics = await fetch(
    `https://api.dub.co/analytics/clicks?projectSlug=cap&domain=cap.link&key=${videoId}`,
    dubOptions
  ).then((response) => response.json());

  if (typeof analytics !== "number") {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return new Response(JSON.stringify({ count: analytics }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
