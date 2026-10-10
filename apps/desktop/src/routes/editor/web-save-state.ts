/**
 * Whether the share link already shows the project the editor opened, so
 * Save has nothing to publish until something changes. A recording nobody
 * has edited doesn't count unless a render of it is published: its share
 * link may still be the raw upload, or its first render may have failed.
 */
export function shareLinkShowsProject(status: {
	state: string;
	current?: boolean;
}) {
	return status.current === true && status.state === "ready";
}
