import { Schema } from "effect";

export type AppSettingSchema = Schema.Schema.All;

export interface AppSettingsDefinition<Settings> {
	schema: Schema.Schema.All;
	createDefault?: () => Settings;
}

export type InferAppSettings<Definition> =
	Definition extends AppSettingsDefinition<infer Settings> ? Settings : never;

type SettingsFromFields<Fields extends Record<string, AppSettingSchema>> = {
	readonly [Key in keyof Fields]: Fields[Key] extends { Type: infer Output }
		? Output
		: never;
};

export const createAppSettings = <
	Fields extends Record<string, AppSettingSchema>,
>(
	fields: Fields,
	options?: { createDefault?: () => SettingsFromFields<Fields> },
): AppSettingsDefinition<SettingsFromFields<Fields>> => {
	const schema = Schema.Struct(fields);

	return {
		schema,
		createDefault: options?.createDefault,
	};
};

export const stringSetting: AppSettingSchema = Schema.String;
