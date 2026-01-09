import type * as i18n from "@solid-primitives/i18n";

export type RawDictionary = {
	settings: {
		general: {
			title: string;
			appearance: {
				title: string;
				system: string;
				light: string;
				dark: string;
			};
			app: {
				title: string;
				alwaysShowDockIcon: {
					label: string;
					description: string;
				};
				enableSystemNotifications: {
					label: string;
					description: string;
				};
			};
			recording: {
				title: string;
				instantModeMaxResolution: {
					label: string;
					description: string;
				};
				recordingCountdown: {
					label: string;
					description: string;
					off: string;
					seconds3: string;
					seconds5: string;
					seconds10: string;
				};
				mainWindowRecordingStartBehaviour: {
					label: string;
					description: string;
					close: string;
					minimise: string;
				};
				studioRecordingFinishBehaviour: {
					label: string;
					description: string;
					openEditor: string;
					showOverlay: string;
				};
				postDeletionBehaviour: {
					label: string;
					description: string;
					doNothing: string;
					reopenRecordingWindow: string;
				};
				deleteInstantRecordingsAfterUpload: {
					label: string;
					description: string;
				};
				crashRecoverableRecording: {
					label: string;
					description: string;
				};
				maxCaptureFramerate: {
					label: string;
					description: string;
					warning: string;
				};
			};
			capProSettings: {
				title: string;
				autoOpenShareableLinks: {
					label: string;
					description: string;
				};
			};
			defaultProjectName: {
				title: string;
				description: string;
				reset: string;
				save: string;
				howToCustomize: string;
			};
			excludedWindows: {
				title: string;
				description: string;
				note: string;
				resetToDefault: string;
				add: string;
				noWindowsExcluded: string;
			};
			selfHost: {
				title: string;
				capServerUrl: {
					label: string;
					description: string;
				};
				update: string;
			};
		};
	};
};

export type Dictionary = i18n.Flatten<RawDictionary>;
