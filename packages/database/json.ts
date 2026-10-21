import { type AnyColumn, type SQL, sql } from "drizzle-orm";

type JsonbSource = AnyColumn | SQL;

const pathLiteral = (path: readonly string[]) => `{${path.join(",")}}`;

export const jsonbObject = (source: JsonbSource) =>
	sql`COALESCE(${source}, '{}'::jsonb)`;

export const jsonbSet = (
	source: JsonbSource,
	path: readonly string[],
	value: unknown,
) =>
	sql`jsonb_set(${jsonbObject(source)}, ${pathLiteral(path)}::text[], ${JSON.stringify(value)}::jsonb)`;

export const jsonbMerge = (source: JsonbSource, patch: object) =>
	sql`(${jsonbObject(source)} || ${JSON.stringify(patch)}::jsonb)`;

export const jsonbRemove = (source: JsonbSource, path: readonly string[]) =>
	sql`(${jsonbObject(source)} #- ${pathLiteral(path)}::text[])`;

export const jsonbGet = (source: JsonbSource, path: readonly string[]) =>
	sql`(${source} #> ${pathLiteral(path)}::text[])`;

export const jsonbText = (source: JsonbSource, path: readonly string[]) =>
	sql<string | null>`(${source} #>> ${pathLiteral(path)}::text[])`;

export const jsonbMergePatch = (source: JsonbSource, patch: object) =>
	sql`jsonb_merge_patch(${jsonbObject(source)}, ${JSON.stringify(patch)}::jsonb)`;
