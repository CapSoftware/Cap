export const formatUsEin = (input: string): string | null => {
	const digits = input.replace(/[\s-]/g, "");
	if (!/^\d{9}$/.test(digits)) return null;
	return `${digits.slice(0, 2)}-${digits.slice(2)}`;
};
