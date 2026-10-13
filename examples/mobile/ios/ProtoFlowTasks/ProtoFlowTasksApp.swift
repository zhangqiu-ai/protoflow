import SwiftUI

/// ProtoFlow launch convention: `-PROTOFLOW_SCREEN <screen>` opens a screen directly and
/// `-PROTOFLOW_FIXTURE <json>` carries the scene's fixture data (both read from launch arguments).
enum ProtoFlowLaunch {
    static var screen: String? { UserDefaults.standard.string(forKey: "PROTOFLOW_SCREEN") }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
    static let accent = Color(hex: 0x0d766e)
    static let ink = Color(hex: 0x18323c)
    static let canvas = Color(hex: 0xf2f5f7)
    static let border = Color(hex: 0xd9e2e5)
    static let danger = Color(hex: 0xad3f3c)
    static let track = Color(hex: 0xe9e9eb)
}

@main
struct ProtoFlowTasksApp: App {
    init() {
        // Captures must not race animations.
        if ProtoFlowLaunch.screen != nil { UIView.setAnimationsEnabled(false) }
    }
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @State private var screen = ProtoFlowLaunch.screen ?? "tasks"
    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            switch screen {
            case "settings": SettingsScreen(open: { screen = $0 })
            default: TasksScreen(open: { screen = $0 })
            }
        }
        .foregroundStyle(Color.ink)
    }
}

/// A screen root fills the safe area; region anchors contain their children.
struct ScreenRoot<Content: View>: View {
    let id: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(id)
    }
}

struct Header: View {
    let prefix: String
    let title: String
    let action: String
    let perform: () -> Void
    var body: some View {
        HStack {
            Text(title).font(.system(size: 28, weight: .bold)).accessibilityIdentifier("\(prefix).title")
            Spacer()
            Button(action: perform) { Text(action).font(.system(size: 17)).foregroundStyle(Color.accent) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("\(prefix).\(action == "Back" ? "back" : "settings")")
        }
        .frame(height: 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(prefix).header")
        .padding(.bottom, 16)
    }
}

struct PrimaryButton: View {
    let title: String
    var wide = false
    let perform: () -> Void
    var body: some View {
        Button(action: perform) {
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 20)
                .frame(maxWidth: wide ? .infinity : nil)
                .frame(height: 44)
                .background(Color.accent, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}
