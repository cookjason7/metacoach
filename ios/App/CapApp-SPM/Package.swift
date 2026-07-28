// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        // Pinned to the exact commit SHA (not a mutable version tag) matching
        // Package.resolved, so a re-tagged or force-pushed release can't be
        // silently pulled in — see GHSA supply-chain guidance on SPM pinning.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", revision: "44ae2505f54a80c5e559533950886d0644fc2fca"),
        .package(name: "CapgoCapacitorHealth", path: "../../../node_modules/@capgo/capacitor-health"),
        .package(name: "CapacitorBrowser", path: "../../../node_modules/@capacitor/browser"),
        .package(name: "CapacitorPushNotifications", path: "../../../node_modules/@capacitor/push-notifications")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapgoCapacitorHealth", package: "CapgoCapacitorHealth"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications")
            ]
        )
    ]
)
