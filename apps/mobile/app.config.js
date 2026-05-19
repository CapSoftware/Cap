const associatedDomains =
	process.env.CAP_MOBILE_DISABLE_ASSOCIATED_DOMAINS === "1"
		? []
		: process.env.CAP_MOBILE_ASSOCIATED_DOMAINS
			? process.env.CAP_MOBILE_ASSOCIATED_DOMAINS.split(",")
					.map((domain) => domain.trim())
					.filter(Boolean)
			: ["applinks:cap.so"];
const bundleIdentifier = "so.cap.mobile";
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
	splash: {
		image: "./assets/splash-icon.png",
		resizeMode: "contain",
		backgroundColor: "#f9f9f9",
	},
	ios,
	experiments: {
		typedRoutes: true,
	},
	plugins: [
		"expo-router",
		[
			"expo-font",
			{
				fonts: [
					"../web/public/fonts/NeueMontreal-Regular.otf",
					"../web/public/fonts/NeueMontreal-Medium.otf",
					"../web/public/fonts/NeueMontreal-Bold.otf",
				],
			},
		],
		[
			"expo-secure-store",
			{
				faceIDPermission: "Allow Cap to protect your account key.",
			},
		],
	],
	extra: {
		apiBaseUrl: process.env.EXPO_PUBLIC_CAP_WEB_URL ?? "https://cap.so",
	},
});
