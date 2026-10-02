/// Matches the desktop exporter (cap_export::prepare_project_for_export):
/// captions show in the preview while enabled, but only reach an export when
/// "Export with Subtitles" is on.
export function exportCaptionSettings(config: Record<string, unknown>) {
	const captions = config.captions;
	if (typeof captions !== "object" || captions === null) return config;
	const settings = (captions as Record<string, unknown>).settings;
	if (typeof settings !== "object" || settings === null) return config;
	const current = settings as Record<string, unknown>;
	return {
		...config,
		captions: {
			...captions,
			settings: {
				...current,
				enabled:
					current.enabled === true && current.exportWithSubtitles === true,
			},
		},
	};
}
