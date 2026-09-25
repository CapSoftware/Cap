import { tmpdir } from "node:os";
import { join } from "node:path";

export const demoVideoId = "ctademovideo001";
export const demoVideoPath =
	process.env.CTA_DEMO_VIDEO ?? join(tmpdir(), "cap-cta-demo", "demo.webm");
export const demoVideoDuration = 14;
