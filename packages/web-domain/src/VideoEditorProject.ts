import { Schema } from "effect";

export const ProjectId = Schema.String.pipe(
	Schema.brand("VideoEditorProjectId"),
);
export type ProjectId = typeof ProjectId.Type;
