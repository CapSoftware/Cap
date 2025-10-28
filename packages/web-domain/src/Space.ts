import { Schema } from "effect";
import { OrganisationId } from "./Organisation.ts";

export const SpaceId = Schema.String.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceIdOrOrganisationId.Type;

export const SpaceIdOrOrganisationId = Schema.Union(SpaceId, OrganisationId);
export type SpaceIdOrOrganisationId = typeof SpaceIdOrOrganisationId.Type;

export const SpaceMemberId = Schema.String.pipe(Schema.brand("SpaceMemberId"));
export type SpaceMemberId = typeof SpaceMemberId.Type;

export const SpaceMemberRole = Schema.Union(
	Schema.Literal("Admin"),
	Schema.Literal("member"),
);
export type SpaceMemberRole = typeof SpaceMemberRole.Type;
