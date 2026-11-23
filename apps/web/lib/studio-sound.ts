import { Schema } from "effect";

export const PreferenceSchema = Schema.Struct({
	enabledByDefault: Schema.Boolean,
	isolation: Schema.Literal("light", "balanced", "strong"),
});

export type Preference = Schema.Schema.Type<typeof PreferenceSchema>;

export const defaultPreference: Preference = {
	enabledByDefault: true,
	isolation: "balanced",
};

export function parsePreference(value: unknown): Preference | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.enabledByDefault !== "boolean") return null;
	if (
		record.isolation !== "light" &&
		record.isolation !== "balanced" &&
		record.isolation !== "strong"
	)
		return null;
	return {
		enabledByDefault: record.enabledByDefault,
		isolation: record.isolation,
	};
}

export function fromUserPreferences(preferences: unknown): Preference {
	if (typeof preferences !== "object" || preferences === null)
		return defaultPreference;
	return (
		parsePreference((preferences as Record<string, unknown>).studioSound) ??
		defaultPreference
	);
}
