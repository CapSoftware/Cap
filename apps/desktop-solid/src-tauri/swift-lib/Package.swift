// swift-tools-version:5.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "swift-lib",
    platforms: [
        .macOS(.v11), // macOS Catalina. Earliest version that is officially supported by Apple.
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "swift-lib",
            type: .static,
            targets: ["swift-lib"]),
    ],
    dependencies: [
        // Dependencies declare other packages that this package depends on.
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.6")
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "swift-lib",
            dependencies: [.product(name: "SwiftRs", package: "swift-rs")],
            path: "src")
    ]
)
