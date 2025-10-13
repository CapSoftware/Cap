import { Schema } from "effect";
import { OrganisationId } from "./Organisation.ts";

export const SpaceId = Schema.String.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceIdOrOrganisationId.Type;

export const SpaceIdOrOrganisationId = Schema.Union(SpaceId, OrganisationId);
export type SpaceIdOrOrganisationId = typeof SpaceIdOrOrganisationId.Type;
