export const formatUsEin = (input: string): string | null => {
	const digits = input.replace(/[\s-]/g, "");
	if (!/^\d{9}$/.test(digits)) return null;
	return `${digits.slice(0, 2)}-${digits.slice(2)}`;
};

export type UsEinChange =
	| { state: "invalid" }
	| { state: "unchanged" }
	| { state: "changed"; ein: string | null };

export const usEinChange = ({
	ein,
	usCompany,
	appliedEin,
	saveUnconfirmed = false,
}: {
	ein: string;
	usCompany: boolean;
	appliedEin: string | null;
	saveUnconfirmed?: boolean;
}): UsEinChange => {
	const value = usCompany ? ein.trim() : "";
	const formatted = value ? formatUsEin(value) : null;
	if (value && !formatted) return { state: "invalid" };
	if (!saveUnconfirmed && formatted === appliedEin) {
		return { state: "unchanged" };
	}
	return { state: "changed", ein: formatted };
};
