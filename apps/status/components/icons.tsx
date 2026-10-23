export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
	return (
		<svg
			aria-hidden="true"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{diagonal ? (
				<path d="M7 17 17 7M7 7h10v10" />
			) : (
				<path d="M5 12h14m-5-5 5 5-5 5" />
			)}
		</svg>
	);
}

export function Check() {
	return (
		<svg
			aria-hidden="true"
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="m6 12 4 4 8-8" />
		</svg>
	);
}

export function ServiceIcon({ id }: { id: string }) {
	const paths: Record<string, string> = {
		website:
			"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c3 3 3 15 0 18-3-3-3-15 0-18Z",
		api: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14",
		sharing: "M15 9h3a4 4 0 0 1 0 8h-4m-5-2H6a4 4 0 0 1 0-8h4m-2 5h8",
		storage:
			"M12 3c5 0 9 2 9 4s-4 4-9 4-9-2-9-4 4-4 9-4ZM3 7v10c0 2 4 4 9 4s9-2 9-4V7M3 12c0 2 4 4 9 4s9-2 9-4",
		media: "M5 4h14v16H5zM5 8h14M5 16h14M9 4v4m6-4v4M9 16v4m6-4v4",
		render:
			"M7 18H6a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10h-1m-8-4 3-3 3 3m-3-3v10",
	};
	return (
		<svg
			aria-hidden="true"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.45"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={paths[id]} />
		</svg>
	);
}
