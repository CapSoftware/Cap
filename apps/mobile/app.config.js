const associatedDomains =
	process.env.CAP_MOBILE_DISABLE_ASSOCIATED_DOMAINS === "1"
		? []
		: process.env.CAP_MOBILE_ASSOCIATED_DOMAINS
			? process.env.CAP_MOBILE_ASSOCIATED_DOMAINS.split(",")
					.map((domain) => domain.trim())
					.filter(Boolean)
			: ["applinks:cap.so"];
const bundleIdentifier = "so.cap.mobile";
const projectId = process.env.EXPO_PROJECT_ID;
const ios = {
	bundleIdentifier,
	supportsTablet: false,
	infoPlist: {
		NSPhotoLibraryUsageDescription:
			"Cap imports videos from Photos for upload.",
		NSPhotoLibraryAddUsageDescription: "Cap saves downloaded videos to Photos.",
		UIBackgroundModes: ["processing"],
	},
};

if (associatedDomains.length > 0) {
	ios.associatedDomains = associatedDomains;
}

module.exports = ({ config }) => ({
	...config,
	name: "Cap",
	slug: "cap-mobile",
	scheme: "cap",
	owner: "cap",
	version: "0.1.0",
	orientation: "portrait",
	platforms: ["ios"],
	userInterfaceStyle: "light",
	icon: "./assets/icon.png",
	ios,
	runtimeVersion: {
		policy: "appVersion",
	},
	updates: projectId
		? {
				url: `https://u.expo.dev/${projectId}`,
			}
		: undefined,
	experiments: {
		typedRoutes: true,
	},
	plugins: [
		"expo-router",
		[
			"expo-camera",
			{
				barcodeScannerEnabled: false,
				cameraPermission: "Allow Cap to use your camera to record videos.",
				microphonePermission:
					"Allow Cap to use your microphone while recording videos.",
			},
		],
		[
			"expo-font",
			{
				fonts: [
					"./assets/fonts/NeueMontreal-Regular.otf",
					"./assets/fonts/NeueMontreal-Medium.otf",
					"./assets/fonts/NeueMontreal-Bold.otf",
				],
			},
		],
		[
			"expo-splash-screen",
			{
				backgroundColor: "#f9f9f9",
				image: "./assets/splash-icon.png",
				imageWidth: 200,
				resizeMode: "contain",
			},
		],
		[
			"expo-secure-store",
			{
				faceIDPermission: "Allow Cap to protect your account key.",
			},
		],
		"expo-sharing",
		"expo-video",
		"expo-web-browser",
	],
	extra: {
		apiBaseUrl: process.env.EXPO_PUBLIC_CAP_WEB_URL ?? "https://cap.so",
		eas: projectId ? { projectId } : undefined,
	},
});
