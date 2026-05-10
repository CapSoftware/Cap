export const getDefaultVideoTitle = (
	kind: "recording" | "screenshot" | "upload",
	formattedDate: string,
) => {
	const label =
		kind === "screenshot"
			? "Screenshot"
			: kind === "upload"
				? "Upload"
				: "Recording";
	return `${label} - ${formattedDate}`;
};

export const removeCapFromVideoTitle = (title: string | null | undefined) =>
	(title ?? "Recording").replace(
		/^Cap (Recording|Screenshot|Upload)(\s+-\s+.*)?$/i,
		(_, kind: string, suffix: string | undefined) =>
			`${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}${suffix ?? ""}`,
	);

export const isDefaultVideoTitle = (title: string | null | undefined) =>
	/^(Cap )?(Recording|Screenshot|Upload)\s+-\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/i.test(
		title ?? "",
	);
