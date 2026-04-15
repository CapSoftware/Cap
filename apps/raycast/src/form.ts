export type FormValues = Record<string, string | string[] | undefined>;

export function getString(values: FormValues, id: string) {
	const value = values[id];
	return typeof value === "string" ? value : "";
}

export function getStringArray(values: FormValues, id: string) {
	const value = values[id];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
