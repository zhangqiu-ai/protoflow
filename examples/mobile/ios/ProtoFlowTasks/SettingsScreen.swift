import SwiftUI

struct SettingsScreen: View {
    let open: (String) -> Void
    @State private var notify = false
    @State private var saved = false

    var body: some View {
        ScreenRoot(id: "settings") {
            Header(prefix: "settings", title: "Settings", action: "Back") { open("tasks") }
            HStack {
                Text("Daily reminder").font(.system(size: 17))
                Spacer()
                Toggle("Daily reminder", isOn: $notify)
                    .labelsHidden()
                    .tint(Color.accent)
                    .accessibilityIdentifier("settings.notify-toggle")
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(.white, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.notify")
            .padding(.bottom, 16)
            PrimaryButton(title: "Save", wide: true) { saved = true }.accessibilityIdentifier("settings.save")
            if saved {
                Text("Saved.")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.accent)
                    .padding(.top, 12)
                    .accessibilityIdentifier("settings.saved")
            }
        }
    }
}
