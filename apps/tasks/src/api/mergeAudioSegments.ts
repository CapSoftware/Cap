import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

const router = express.Router();

router.post<{}>("/", async (req, res) => {
  const body = req.body;

  if (!body.segments || body.segments.length === 0 || !body.uploadUrl) {
    res.status(400).json({ message: "Segments or uploadUrl not provided" });
    return;
  }

  // Create a ffmpeg command
  const command = ffmpeg();

  // Add the audio files as inputs
  for (const url of body.segments) {
    command.input(url);
  }

  // Merge the audio files
  command
    .on("error", (err: any) => {
      console.log("An error occurred: " + err.message);
    })
    .on("end", async () => {
      console.log("Merging finished !");

      const buffer = fs.readFileSync("./merged.mp3");

      const uploadResponse = await fetch(body.uploadUrl, {
        method: "PUT",
        body: buffer,
        headers: {
          "Content-Type": "audio/mpeg",
        },
      });

      if (!uploadResponse.ok) {
        console.error("Upload failed: ", await uploadResponse.text());
        res.status(500).json({ message: "Upload failed" });
        return;
      }

      res.json({ response: "COMPLETE" });
    })
    .mergeToFile("./merged.mp3", "./");
});

export default router;
