import { Schema } from "effect";

export class Organisation extends Schema.Class<Organisation>("Organisation")({
	id: Schema.String.pipe(Schema.brand("OrganisationId")),
	name: Schema.String,
}) {}
