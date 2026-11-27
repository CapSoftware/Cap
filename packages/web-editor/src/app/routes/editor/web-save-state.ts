export function shareLinkShowsProject(status: {
	state: string;
	current?: boolean;
}) {
	return status.current === true && status.state === "ready";
}
