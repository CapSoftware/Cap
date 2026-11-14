import type {
	InstallationSettings,
	SettingField,
	SettingValue,
} from "@cap/app-store";

export const SETTING_TEXT_MAX_LENGTH = 2_000;

export type SettingsInput = Record<string, unknown>;

export type SettingsResult =
	| { ok: true; settings: InstallationSettings }
	| { ok: false; errors: Record<string, string> };

export type PublicSettings = {
	values: Record<string, SettingValue>;
	secretsSet: string[];
};

function isHttpsUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

export function defaultSettings(
	fields: readonly SettingField[],
): InstallationSettings {
	const settings: InstallationSettings = {};
	for (const field of fields) {
		if (field.type === "toggle") settings[field.key] = field.default ?? false;
		else if (field.type !== "secret" && field.default !== undefined) {
			settings[field.key] = field.default;
		}
	}
	return settings;
}

export function resolveSettings(
	fields: readonly SettingField[],
	input: SettingsInput,
	existing: InstallationSettings | null,
): SettingsResult {
	const settings: InstallationSettings = {};
	const errors: Record<string, string> = {};

	for (const field of fields) {
		const raw = input[field.key];
		const previous = existing?.[field.key];

		if (field.type === "toggle") {
			if (raw === undefined) {
				settings[field.key] =
					typeof previous === "boolean" ? previous : (field.default ?? false);
			} else if (typeof raw === "boolean") {
				settings[field.key] = raw;
			} else {
				errors[field.key] = "Must be on or off";
			}
			continue;
		}

		if (raw !== undefined && raw !== null && typeof raw !== "string") {
			errors[field.key] = "Must be text";
			continue;
		}
		const value = typeof raw === "string" ? raw.trim() : "";

		if (field.type === "secret") {
			if (value) settings[field.key] = value;
			else if (typeof previous === "string" && previous) {
				settings[field.key] = previous;
			} else if (field.required) {
				errors[field.key] = `${field.label} is required`;
			}
			if (value.length > SETTING_TEXT_MAX_LENGTH) {
				errors[field.key] = `${field.label} is too long`;
			}
			continue;
		}

		const resolved =
			raw === undefined && typeof previous === "string"
				? previous
				: value || (raw === undefined ? (field.default ?? "") : "");

		if (!resolved) {
			if (field.required) errors[field.key] = `${field.label} is required`;
			continue;
		}
		if (resolved.length > SETTING_TEXT_MAX_LENGTH) {
			errors[field.key] = `${field.label} is too long`;
			continue;
		}
		if (field.type === "url" && !isHttpsUrl(resolved)) {
			errors[field.key] = `${field.label} must be an https:// URL`;
			continue;
		}
		if (
			field.type === "select" &&
			!field.options.some((option) => option.value === resolved)
		) {
			errors[field.key] = `Choose one of the options for ${field.label}`;
			continue;
		}
		settings[field.key] = resolved;
	}

	return Object.keys(errors).length > 0
		? { ok: false, errors }
		: { ok: true, settings };
}

export function publicSettings(
	fields: readonly SettingField[],
	settings: InstallationSettings,
): PublicSettings {
	const values: Record<string, SettingValue> = {};
	const secretsSet: string[] = [];
	for (const field of fields) {
		const value = settings[field.key];
		if (field.type === "secret") {
			if (typeof value === "string" && value) secretsSet.push(field.key);
			continue;
		}
		if (value !== undefined) values[field.key] = value;
	}
	return { values, secretsSet };
}

export function parseStoredSettings(raw: string | null): InstallationSettings {
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const settings: InstallationSettings = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string" || typeof value === "boolean") {
			settings[key] = value;
		}
	}
	return settings;
}
