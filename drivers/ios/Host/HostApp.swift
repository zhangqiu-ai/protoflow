import SwiftUI

/// Host required by the UI testing bundle. Captures drive the target app by bundle identifier; the host only
/// measures the device's safe area, which the driver uses as the native content frame.
@main
struct ProtoFlowDriverHost: App {
    var body: some Scene {
        WindowGroup {
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .accessibilityElement()
                .accessibilityLabel("ProtoFlow safe area")
                .accessibilityIdentifier("protoflow.safe-area")
        }
    }
}
