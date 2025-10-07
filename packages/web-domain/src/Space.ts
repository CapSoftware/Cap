import { Schema } from "effect";

export const SpaceId = Schema.String; // TODO: .pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;
