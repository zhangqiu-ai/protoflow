import XCTest

/*
 * ProtoFlow iOS capture. One run = one scene: launch the target app on a screen, replay the anchor steps, then
 * write the raw accessibility snapshot and a device screenshot. The Node driver (scripts/ios-driver.js) turns the
 * raw tree into protocol facts, so this file stays a thin, platform-only layer.
 *
 * Input: the JSON file named by the PROTOFLOW_DRIVER_JOB environment variable (passed as TEST_RUNNER_…).
 * Output: <job.outputDir>/raw.json and <job.outputDir>/device.png.
 */
final class CaptureTests: XCTestCase {
    struct Step: Decodable { let action: String; let anchor: String?; let value: String?; let timeoutMs: Int? }
    struct Job: Decodable {
        let bundleId: String
        let screen: String
        let launchArguments: [String]
        let launchUrl: String?
        let steps: [Step]
        let outputDir: String
        let timeoutMs: Int?
        let launchTimeoutMs: Int?
        let probeSafeArea: Bool?
    }

    func testCapture() throws {
        guard let path = ProcessInfo.processInfo.environment["PROTOFLOW_DRIVER_JOB"] else { return XCTFail("PROTOFLOW_DRIVER_JOB is not set") }
        let job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let output = URL(fileURLWithPath: job.outputDir)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let app = XCUIApplication(bundleIdentifier: job.bundleId)
        var result: [String: Any] = [:]
        var safeArea: [String: Double]? = nil
        defer {
            if let safeArea { result["safeArea"] = safeArea }
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
                try? data.write(to: output.appendingPathComponent("raw.json"))
            }
            app.terminate()
        }
        let timeout = Double(job.timeoutMs ?? 10000) / 1000
        // Cold launches (React Native loads its JS bundle) take longer than a step.
        let launchTimeout = Double(job.launchTimeoutMs ?? 60000) / 1000
        if job.probeSafeArea == true {
            // The host app fills exactly the safe area; its frame is the device's content frame.
            let host = XCUIApplication()
            host.launch()
            let probe = host.descendants(matching: .any).matching(identifier: "protoflow.safe-area").firstMatch
            if probe.waitForExistence(timeout: timeout) {
                let frame = probe.frame
                safeArea = ["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height]
            }
            host.terminate()
        }
        app.terminate()
        if let launchUrl = job.launchUrl {
            // Deep-link apps (Expo Router) cold-start on the route the URL names; launch arguments do not apply.
            guard let url = URL(string: launchUrl) else {
                result = ["status": "FAIL", "reason": "launch URL \(launchUrl) is not a valid URL"]
                return
            }
            app.open(url)
        } else {
            app.launchArguments = job.launchArguments
            app.launch()
        }
        guard app.wait(for: .runningForeground, timeout: launchTimeout) else {
            result = ["status": "FAIL", "reason": "app \(job.bundleId) did not reach the foreground"]
            return
        }
        guard element(app, job.screen).waitForExistence(timeout: launchTimeout) else {
            result = failure(app, output, "screen anchor \(job.screen) did not appear (does the app honour \(job.launchUrl.map { "the launch URL \($0)" } ?? "-PROTOFLOW_SCREEN")?)")
            return
        }
        for (index, step) in job.steps.enumerated() {
            if let reason = perform(app, step, timeout: Double(step.timeoutMs ?? job.timeoutMs ?? 10000) / 1000) {
                result = failure(app, output, "step \(index + 1) \(step.action) \(step.anchor ?? ""): \(reason)")
                return
            }
        }
        // Let layout settle after the last step; XCUITest already waits for the app to be idle on each query.
        Thread.sleep(forTimeInterval: 0.3)
        let snapshot = try app.snapshot()
        let screenshot = XCUIScreen.main.screenshot()
        try screenshot.pngRepresentation.write(to: output.appendingPathComponent("device.png"))
        let keyboard = app.keyboards.firstMatch
        result = [
            "status": "PASS",
            "keyboardVisible": keyboard.exists,
            "tree": serialize(snapshot),
            "screenshot": "device.png"
        ]
        // A state that ends while typing may keep the keyboard up; the engine leaves its frame out of the comparison.
        if keyboard.exists {
            let frame = keyboard.frame
            result["keyboardFrame"] = ["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height]
        }
    }

    /// A failed capture still keeps what the screen showed: the screenshot and tree are evidence, never compared.
    private func failure(_ app: XCUIApplication, _ output: URL, _ reason: String) -> [String: Any] {
        var item: [String: Any] = ["status": "FAIL", "reason": reason]
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: output.appendingPathComponent("failure.png"))
        if let snapshot = try? app.snapshot() { item["tree"] = serialize(snapshot) }
        return item
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func perform(_ app: XCUIApplication, _ step: Step, timeout: Double) -> String? {
        if step.action == "back" {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            guard back.waitForExistence(timeout: timeout) else { return "no navigation back button" }
            back.tap()
            return nil
        }
        guard let anchor = step.anchor else { return "step has no anchor" }
        let target = element(app, anchor)
        guard target.waitForExistence(timeout: timeout) else { return "anchor \(anchor) not found" }
        switch step.action {
        case "wait-for":
            return nil
        case "tap":
            target.tap()
        case "toggle":
            let control = target.elementType == .switch || target.elementType == .toggle ? target : target.switches.firstMatch
            (control.exists ? control : target).tap()
        case "fill", "clear":
            target.tap()
            clear(target)
            if step.action == "fill" { return type(step.value ?? "", into: target) }
        case "select":
            let wheel = target.pickerWheels.firstMatch
            if wheel.exists { wheel.adjust(toPickerWheelValue: step.value ?? "") } else {
                target.tap()
                let option = app.buttons[step.value ?? ""]
                guard option.waitForExistence(timeout: timeout) else { return "option \(step.value ?? "") not found" }
                option.tap()
            }
        case "scroll-to":
            var attempts = 0
            while !target.isHittable && attempts < 10 { app.swipeUp(); attempts += 1 }
            if !target.isHittable { return "anchor \(anchor) is not reachable by scrolling" }
        default:
            return "unsupported action"
        }
        return nil
    }

    /// Stable names for the element types the Node driver interprets; anything else is reported as other.
    private func typeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .application: return "application"
        case .window: return "window"
        case .button: return "button"
        case .link: return "link"
        case .staticText: return "staticText"
        case .textField: return "textField"
        case .secureTextField: return "secureTextField"
        case .searchField: return "searchField"
        case .textView: return "textView"
        case .switch: return "switch"
        case .toggle: return "toggle"
        case .checkBox: return "checkBox"
        case .radioButton: return "radioButton"
        case .slider: return "slider"
        case .stepper: return "stepper"
        case .picker: return "picker"
        case .pickerWheel: return "pickerWheel"
        case .datePicker: return "datePicker"
        case .segmentedControl: return "segmentedControl"
        case .image: return "image"
        case .cell: return "cell"
        case .table: return "table"
        case .collectionView: return "collectionView"
        case .scrollView: return "scrollView"
        case .navigationBar: return "navigationBar"
        case .tabBar: return "tabBar"
        case .toolbar: return "toolbar"
        case .statusBar: return "statusBar"
        case .keyboard: return "keyboard"
        case .alert: return "alert"
        case .menuItem: return "menuItem"
        case .tab: return "tab"
        case .webView: return "webView"
        default: return "other"
        }
    }

    private func fieldValue(_ field: XCUIElement) -> String {
        let value = field.value as? String ?? ""
        return value == field.placeholderValue ? "" : value
    }

    private func clear(_ field: XCUIElement) {
        let current = fieldValue(field)
        if !current.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
    }

    /// Typing can drop keystrokes on a busy simulator (notably into React Native controlled inputs): read the field
    /// back and retype, character by character, before reporting a failure. Secure fields cannot be read back.
    private func type(_ text: String, into field: XCUIElement) -> String? {
        field.typeText(text)
        if field.elementType == .secureTextField { return nil }
        for _ in 0..<3 {
            if fieldValue(field) == text { return nil }
            clear(field)
            for character in text {
                field.typeText(String(character))
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        let shown = fieldValue(field)
        return shown == text ? nil : "field shows \"\(shown)\" instead of \"\(text)\" after typing"
    }

    private func serialize(_ node: XCUIElementSnapshot) -> [String: Any] {
        var item: [String: Any] = [
            "type": typeName(node.elementType),
            "identifier": node.identifier,
            "label": node.label,
            "enabled": node.isEnabled,
            "selected": node.isSelected,
            "frame": ["x": node.frame.origin.x, "y": node.frame.origin.y, "width": node.frame.size.width, "height": node.frame.size.height]
        ]
        if let value = node.value { item["value"] = "\(value)" }
        if let placeholder = node.placeholderValue { item["placeholder"] = placeholder }
        let children = node.children.map(serialize)
        if !children.isEmpty { item["children"] = children }
        return item
    }
}
