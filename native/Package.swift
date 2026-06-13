// swift-tools-version: 6.0
import PackageDescription

// Compost SwiftUI spike (ADR 0003 §4: a native shell over the engine contract).
// Throwaway viability proof — NOT a product. See native/README.md.
//
// Layout:
//   CompostKit  — pure logic: Codable transcript models, event reducer (port of
//                 provenance/src/reducer.ts), read-only events.sqlite reader, and
//                 the CompostCLI subprocess wrapper. Testable, no UI.
//   CompostSpike — the SwiftUI macOS app (rendering shell only).
//   Probe        — a headless command-line that exercises the engine boundary
//                  end-to-end (P0 spawn + P2 ledger reduce + P3 round-trip), so
//                  the contract is verifiable without a GUI display.
//
// Language mode v5 on purpose: a spike should not fight Swift 6 strict-concurrency
// over Process plumbing. The reducer port is what we want to prove, not Sendable.
let package = Package(
    name: "CompostSpike",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CompostKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(
            name: "CompostSpike",
            dependencies: ["CompostKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Probe",
            dependencies: ["CompostKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "CompostKitTests",
            dependencies: ["CompostKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
