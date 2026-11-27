export function formatTime(secs: number, fps?: number) {
	const hours = Math.floor(secs / 3600);
	const minutes = Math.floor(secs / 60) - hours * 60;
	const seconds = Math.floor(secs % 60);
	const frames = fps === undefined ? undefined : Math.floor((secs % 1) * fps);

	let str =
		hours > 0
			? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
			: `${minutes}:${seconds.toString().padStart(2, "0")}`;

	if (frames !== undefined) {
		str += `.${frames.toString().padStart(2, "0 ")}`;
	}

	return str;
}
