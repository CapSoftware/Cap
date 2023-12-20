import { createRouteClient } from "@/utils/database/supabase/server";

export async function POST(request: Request) {
  const res = await request.json();
  const { s3_url, name, duration, thumbnail_url, metadata, is_public } =
    res.body;

  // Simple validation
  if (!s3_url || !name) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const supabase = createRouteClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }

  // Insert data into the videos table
  const { data, error } = await supabase.from("videos").insert([
    {
      owner_id: session.user.id,
      s3_url,
      name,
      duration,
      thumbnail_url,
      metadata: metadata || {},
      is_public: false,
    },
  ]);

  console.log("supabase response:");
  console.log(data);
  console.log(error);

  if (data !== null) {
    return new Response("Success", {
      status: 200,
    });
  }

  return new Response("Error saving video", {
    status: 400,
  });
}
