// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "MobiAd",
    platforms: [.iOS(.v13), .macOS(.v10_15)],
    products: [.library(name: "MobiAd", targets: ["MobiAd"])],
    targets: [.target(name: "MobiAd")]
)
