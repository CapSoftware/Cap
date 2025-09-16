import { Workflow } from "@effect/workflow";
import { Schema } from "effect";

export const ImportVideo = Workflow.make({
	name: "LoomImportVideo",
	payload: {
		userId: Schema.String,
		loomVideoId: Schema.String,
		loomOrgId: Schema.String,
		orgId: Schema.String,
		downloadUrl: Schema.String,
	},
	idempotencyKey: (p) => `${p.loomOrgId}-${p.loomVideoId}`,
});
