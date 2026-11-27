export function validWebEditorTitle(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 5 &&
		value.length <= 100 &&
		value.trim() === value &&
		![...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || (code >= 127 && code <= 159);
		})
	);
}
