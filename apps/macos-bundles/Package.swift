// swift-tools-version:5.9
import PackageDescription

let extensionEntryPoint: [LinkerSetting] = [
	.unsafeFlags(["-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"]),
]

let package = Package(
	name: "CapMacOSBundles",
	platforms: [.macOS(.v12)],
	products: [
		.executable(name: "CapQuickLookThumbnail", targets: ["CapQuickLookThumbnail"]),
		.executable(name: "CapQuickLookPreview", targets: ["CapQuickLookPreview"]),
	],
	targets: [
		.target(
			name: "CapShared",
			path: "Sources/CapShared"
		),
		.executableTarget(
			name: "CapQuickLookThumbnail",
			dependencies: ["CapShared"],
			path: "Sources/CapQuickLookThumbnail",
			linkerSettings: [.linkedFramework("QuickLookThumbnailing")] + extensionEntryPoint
		),
		.executableTarget(
			name: "CapQuickLookPreview",
			dependencies: ["CapShared"],
			path: "Sources/CapQuickLookPreview",
			linkerSettings: [.linkedFramework("Quartz")] + extensionEntryPoint
		),
	]
)
