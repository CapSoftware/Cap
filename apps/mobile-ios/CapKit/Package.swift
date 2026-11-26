// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CapKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "CapKit", targets: ["CapKit"]),
    ],
    targets: [
        .target(name: "CapKit"),
        .testTarget(
            name: "CapKitTests",
            dependencies: ["CapKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
