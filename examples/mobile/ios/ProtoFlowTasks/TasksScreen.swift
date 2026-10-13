import SwiftUI

struct TasksScreen: View {
    let open: (String) -> Void
    @State private var items = ["Review prototype", "Ship version"]
    @State private var draft = ""
    @State private var showError = false
    @FocusState private var focused: Bool

    var body: some View {
        ScreenRoot(id: "tasks") {
            Header(prefix: "tasks", title: "Today", action: "Settings") { open("settings") }
            VStack(spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text(item)
                        .font(.system(size: 17))
                        .padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(height: 48)
                        .background(.white, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("tasks.item")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tasks.list")
            .padding(.bottom, 16)
            HStack(spacing: 10) {
                TextField("New task", text: $draft)
                    .font(.system(size: 17))
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .frame(height: 44)
                    .background(.white, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.border, lineWidth: 1))
                    .accessibilityIdentifier("tasks.input")
                PrimaryButton(title: "Add", perform: add).accessibilityIdentifier("tasks.add")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tasks.form")
            if showError {
                Text("Enter a task first.")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.danger)
                    .padding(.top, 12)
                    .accessibilityIdentifier("tasks.error")
            }
        }
    }

    private func add() {
        focused = false
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { showError = true; return }
        showError = false
        items.append(text)
        draft = ""
    }
}
