import { Workflow } from "@effect/workflow";
import { Schema } from "effect";

import * as Video from "./Video.ts";
import { UserId } from "./User.ts";
import { OrganisationId } from "./Organisation.ts";

class LoomApiError extends Schema.TaggedError<LoomApiError>("LoomApiError")(
	"LoomApiError",
	{ cause: Schema.Unknown },
) {}

const LoomImportVideoError = Schema.Union(
	// DatabaseError,
	Video.NotFoundError,
	// S3Error,
	LoomApiError,
);

export const LoomImportVideo = Workflow.make({
	name: "LoomImportVideo",
	payload: {
		cap: Schema.Struct({
			userId: UserId,
			orgId: OrganisationId,
		}),
		loom: Schema.Struct({
			userId: UserId,
			orgId: OrganisationId,
			video: Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				downloadUrl: Schema.String,
				width: Schema.OptionFromNullOr(Schema.Number),
				height: Schema.OptionFromNullOr(Schema.Number),
				fps: Schema.OptionFromNullOr(Schema.Number),
				durationSecs: Schema.OptionFromNullOr(Schema.Number),
			}),
		}),
		attempt: Schema.optional(Schema.Number),
	},
	error: LoomImportVideoError,
	idempotencyKey: (p) =>
		`${p.cap.userId}-${p.loom.orgId}-${p.loom.video.id}-${p.attempt ?? 0}`,
});
