import express from "express";

import type MessageResponse from "../interfaces/MessageResponse";
import mergeAudioSegments from "./mergeAudioSegments";

const router = express.Router();

router.get<{}, MessageResponse>("/", (req, res) => {
	res.json({
		message: "OK",
	});
});

router.use("/merge-audio-segments", mergeAudioSegments);

export default router;
