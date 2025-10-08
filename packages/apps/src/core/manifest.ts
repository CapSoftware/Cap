import { Schema } from "effect";

export const AppManifestSchema = Schema.Struct({
  type: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  icon: Schema.String,
  category: Schema.String,
  requiredEnvVars: Schema.Array(Schema.String),
  installModule: Schema.optional(Schema.String),
  image: Schema.String,
  documentation: Schema.String,
  contentPath: Schema.optional(Schema.String),
});

export type AppManifest = typeof AppManifestSchema.Type;

export const DEFAULT_INSTALL_MODULE = "./install.ts" as const;
