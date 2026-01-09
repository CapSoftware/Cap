import type { RawDictionary } from "./types";

const zhCN: RawDictionary = {
	settings: {
		general: {
			title: "通用设置",
			appearance: {
				title: "外观",
				system: "跟随系统",
				light: "亮色",
				dark: "暗色",
			},
			app: {
				title: "应用",
				alwaysShowDockIcon: {
					label: "始终在程序坞显示图标",
					description: "即使没有可关闭的窗口，也在程序坞中显示 Cap。",
				},
				enableSystemNotifications: {
					label: "启用系统通知",
					description:
						"显示诸如复制到剪贴板、保存文件等事件的系统通知。您可能需要在系统设置中手动允许 Cap 的通知权限。",
				},
			},
			recording: {
				title: "录制",
				instantModeMaxResolution: {
					label: "即时模式最大分辨率",
					description: "选择即时模式录制的最大分辨率。",
				},
				recordingCountdown: {
					label: "录制倒计时",
					description: "录制开始前的倒计时",
					off: "关闭",
					seconds3: "3 秒",
					seconds5: "5 秒",
					seconds10: "10 秒",
				},
				mainWindowRecordingStartBehaviour: {
					label: "主窗口录制开始行为",
					description: "开始录制时主窗口的行为",
					close: "关闭",
					minimise: "最小化",
				},
				studioRecordingFinishBehaviour: {
					label: "Studio 录制完成行为",
					description: "Studio 录制完成后的行为",
					openEditor: "打开编辑器",
					showOverlay: "在覆盖层显示",
				},
				postDeletionBehaviour: {
					label: "删除录制后行为",
					description: "删除正在进行的录制后，Cap 是否应该重新打开？",
					doNothing: "什么也不做",
					reopenRecordingWindow: "重新打开录制窗口",
				},
				deleteInstantRecordingsAfterUpload: {
					label: "上传后删除即时模式录制",
					description: "完成即时录制后，Cap 是否应从您的设备中删除它？",
				},
				crashRecoverableRecording: {
					label: "崩溃可恢复录制",
					description:
						"以分段形式录制，如果应用程序崩溃或系统断电，可以恢复录制。录制期间可能会占用稍多的存储空间。",
				},
				maxCaptureFramerate: {
					label: "最大捕获帧率",
					description:
						"屏幕捕获的最大帧率。较高的值可能会导致某些系统不稳定。",
					warning:
						"⚠️ 较高的帧率可能会导致帧丢失或增加某些系统的 CPU 使用率。",
				},
			},
			capProSettings: {
				title: "Cap Pro 设置",
				autoOpenShareableLinks: {
					label: "自动打开共享链接",
					description: "Cap 是否应自动在浏览器中打开即时录制",
				},
			},
			defaultProjectName: {
				title: "默认项目名称",
				description: "选择用作默认项目和文件名的模板。",
				reset: "重置",
				save: "保存",
				howToCustomize: "如何自定义？",
			},
			excludedWindows: {
				title: "排除的窗口",
				description: "选择 Cap 在录制中隐藏哪些窗口。",
				note: "注意：由于技术限制，在 Windows 上只能排除 Cap 相关的窗口。",
				resetToDefault: "恢复默认",
				add: "添加",
				noWindowsExcluded: "当前没有排除任何窗口。",
			},
			selfHost: {
				title: "自托管",
				capServerUrl: {
					label: "Cap 服务器 URL",
					description:
						"仅当您自托管 Cap Web 实例时才应更改此设置。",
				},
				update: "更新",
			},
		},
	},
};

export default zhCN;
