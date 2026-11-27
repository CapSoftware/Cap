import { videos } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import type { CapKind } from "./cap-kind";

export const capKindCondition = (kind: CapKind) =>
	kind === "notes"
		? eq(videos.isNote, true)
		: and(eq(videos.isNote, false), eq(videos.isScreenshot, kind === "images"));
