import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

const router = express.Router();

router.post<{}>("/", async (req, res) => {
	const body = req.body;

	if (
		!body.segments ||
		body.segments.length === 0 ||
		!body.uploadUrl ||
		!body.videoId
	) {
		res.status(400).json({ response: "FAILED" });
		return;
	}

	const outputDir = "./output";
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir);
	}

	const command = ffmpeg();
	const filePath = `./output/merged_${body.videoId}.mp3`;

	for (const url of body.segments) {
		command.input(url);
	}

	command
		.audioCodec("libmp3lame")
		.on("error", (err: any) => {
			console.log("An error occurred: " + err.message);
		})
		.on("end", async () => {
			console.log("Merging finished!");

			const buffer = fs.readFileSync(filePath);

			const uploadResponse = await fetch(body.uploadUrl, {
				method: "PUT",
				body: buffer,
				headers: {
					"Content-Type": "audio/mpeg",
				},
			});

			fs.unlinkSync(filePath);

			if (!uploadResponse.ok) {
				console.error("Upload failed: ", await uploadResponse.text());
				res.status(500).json({ response: "FAILED" });
				return;
			}

			res.status(200).json({ response: "COMPLETE" });
		})
		.mergeToFile(filePath, "./");
});

export default router;
