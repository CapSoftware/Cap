export function placeholders(count: number) {
	return Array.from({ length: count }, () => "?").join(",");
}
