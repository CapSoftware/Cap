export const Tokens = ({ text }: { text: string }) => {
	const parts = text.split(" ");
	const seen = new Map<string, number>();
	return parts.map((token, i) => {
		const n = seen.get(token) ?? 0;
		seen.set(token, n + 1);
		return (
			<span key={`${token}#${n}`}>
				<span className="whitespace-nowrap">{token}</span>
				{i < parts.length - 1 ? " " : ""}
			</span>
		);
	});
};
