import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("*", cors());

app.get("/", (c) => {
  return c.json({ message: "OK" });
});

app.post("/api/v1/merge-audio-segments", async (c) => {
  const body = await c.req.json();

  if (
    !body.segments ||
    body.segments.length === 0 ||
    !body.uploadUrl ||
    !body.videoId
  ) {
    return c.json({ response: "FAILED" }, 400);
  }

  const outputDir = "./output";
  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch {
  }

  const filePath = `${outputDir}/merged_${body.videoId}.mp3`;

  const ffmpegArgs = [
    "-y",
  ];

  for (const url of body.segments) {
    ffmpegArgs.push("-i", url);
  }

  ffmpegArgs.push(
    "-filter_complex",
    `concat=n=${body.segments.length}:v=0:a=1`,
    "-acodec",
    "libmp3lame",
    filePath
  );

  const command = new Deno.Command("ffmpeg", {
    args: ffmpegArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();
  const { code } = await process.status;

  if (code !== 0) {
    console.error("FFmpeg failed with code:", code);
    return c.json({ response: "FAILED" }, 500);
  }

  console.log("Merging finished!");

  const buffer = await Deno.readFile(filePath);

  const uploadResponse = await fetch(body.uploadUrl, {
    method: "PUT",
    body: buffer,
    headers: {
      "Content-Type": "audio/mpeg",
    },
  });

  try {
    await Deno.remove(filePath);
  } catch {
  }

  if (!uploadResponse.ok) {
    console.error("Upload failed: ", await uploadResponse.text());
    return c.json({ response: "FAILED" }, 500);
  }

  return c.json({ response: "COMPLETE" });
});

const port = Number(Deno.env.get("PORT")) || 3002;

console.log(`Listening: http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
