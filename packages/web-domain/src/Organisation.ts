import { Schema } from "effect";

export const OrganisationId = Schema.String.pipe(
	Schema.brand("OrganisationId"),
);
export type OrganisationId = typeof OrganisationId.Type;

export class Organisation extends Schema.Class<Organisation>("Organisation")({
	id: OrganisationId,
	name: Schema.String,
}) {}
