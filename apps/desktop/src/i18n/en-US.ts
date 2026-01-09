import type { RawDictionary } from "./types";

const enUS: RawDictionary = {
	settings: {
		general: {
			title: "General Settings",
			appearance: {
				title: "Appearance",
				system: "System",
				light: "Light",
				dark: "Dark",
			},
			app: {
				title: "App",
				alwaysShowDockIcon: {
					label: "Always show dock icon",
					description:
						"Show Cap in the dock even when there are no windows available to close.",
				},
				enableSystemNotifications: {
					label: "Enable system notifications",
					description:
						"Show system notifications for events like copying to clipboard, saving files, and more. You may need to manually allow Cap access via your system's notification settings.",
				},
			},
			recording: {
				title: "Recording",
				instantModeMaxResolution: {
					label: "Instant mode max resolution",
					description:
						"Choose the maximum resolution for Instant Mode recordings.",
				},
				recordingCountdown: {
					label: "Recording countdown",
					description: "Countdown before recording starts",
					off: "Off",
					seconds3: "3 seconds",
					seconds5: "5 seconds",
					seconds10: "10 seconds",
				},
				mainWindowRecordingStartBehaviour: {
					label: "Main window recording start behaviour",
					description: "The main window recording start behaviour",
					close: "Close",
					minimise: "Minimise",
				},
				studioRecordingFinishBehaviour: {
					label: "Studio recording finish behaviour",
					description: "The studio recording finish behaviour",
					openEditor: "Open editor",
					showOverlay: "Show in overlay",
				},
				postDeletionBehaviour: {
					label: "After deleting recording behaviour",
					description:
						"Should Cap reopen after deleting an in progress recording?",
					doNothing: "Do Nothing",
					reopenRecordingWindow: "Reopen Recording Window",
				},
				deleteInstantRecordingsAfterUpload: {
					label: "Delete instant mode recordings after upload",
					description:
						"After finishing an instant recording, should Cap will delete it from your device?",
				},
				crashRecoverableRecording: {
					label: "Crash-recoverable recording",
					description:
						"Records in fragmented segments that can be recovered if the app crashes or your system loses power. May have slightly higher storage usage during recording.",
				},
				maxCaptureFramerate: {
					label: "Max capture framerate",
					description:
						"Maximum framerate for screen capture. Higher values may cause instability on some systems.",
					warning:
						"⚠️ Higher framerates may cause frame drops or increased CPU usage on some systems.",
				},
			},
			capProSettings: {
				title: "Cap Pro Settings",
				autoOpenShareableLinks: {
					label: "Automatically open shareable links",
					description:
						"Whether Cap should automatically open instant recordings in your browser",
				},
			},
			defaultProjectName: {
				title: "Default Project Name",
				description:
					"Choose the template to use as the default project and file name.",
				reset: "Reset",
				save: "Save",
				howToCustomize: "How to customize?",
			},
			excludedWindows: {
				title: "Excluded Windows",
				description: "Choose which windows Cap hides from your recordings.",
				note: "Note: Only Cap related windows can be excluded on Windows due to technical limitations.",
				resetToDefault: "Reset to Default",
				add: "Add",
				noWindowsExcluded: "No windows are currently excluded.",
			},
			selfHost: {
				title: "Self host",
				capServerUrl: {
					label: "Cap Server URL",
					description:
						"This setting should only be changed if you are self hosting your own instance of Cap Web.",
				},
				update: "Update",
			},
		},
	},
};

export default enUS;
