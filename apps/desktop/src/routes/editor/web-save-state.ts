/**
 * Whether a share link already shows what the editor opened with, so Save
 * has nothing to publish until something changes: it shows the stored
 * project, or the recording nobody has edited. One opened straight from the
 * recorder still publishes in its default style.
 */
export function shareLinkShowsProject(
	status: { current?: boolean; edited?: boolean },
	openedFromRecorder: boolean,
) {
	return (
		status.current === true || (status.edited === false && !openedFromRecorder)
	);
}
