import XCTest
import UIKit
import Darwin
import CoreFoundation

// BEGIN HOST LAUNCH PREPARATION: Foundation-only channel, also exercised without a Simulator.
struct NativeLaunchPreparation: Decodable {
    let directory: String
    let token: String
    let timeoutMs: Int
}

private func privateLaunchDirectory(_ directory: String) throws {
    guard directory.hasPrefix("/"), let canonical = Darwin.realpath(directory, nil) else { throw CocoaError(.fileReadNoPermission) }
    defer { free(canonical) }
    guard String(cString: canonical) == directory else { throw CocoaError(.fileReadNoPermission) }
    let descriptor = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw CocoaError(.fileReadNoPermission) }
    defer { close(descriptor) }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0, metadata.st_uid == getuid(),
          metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), metadata.st_mode & 0o777 == 0o700 else {
        throw CocoaError(.fileReadNoPermission)
    }
}

private func privateLaunchData(_ file: String) throws -> Data? {
    let descriptor = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if descriptor < 0 && errno == ENOENT { return nil }
    guard descriptor >= 0 else { throw CocoaError(.fileReadNoPermission) }
    defer { close(descriptor) }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_nlink == 1,
          metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), metadata.st_mode & 0o777 == 0o600,
          metadata.st_size >= 0, metadata.st_size <= 65536 else { throw CocoaError(.fileReadNoPermission) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    let bytes = try handle.read(upToCount: 65537) ?? Data()
    guard bytes.count <= 65536 else { throw CocoaError(.fileReadTooLarge) }
    return bytes
}

private func writePrivateLaunchRequest(_ bytes: Data, folder: String, requestId: String) throws {
    let temporary = folder + "/.request-\(requestId).json"
    let descriptor = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw CocoaError(.fileWriteNoPermission) }
    defer { close(descriptor); unlink(temporary) }
    guard fchmod(descriptor, 0o600) == 0 else { throw CocoaError(.fileWriteNoPermission) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    try handle.write(contentsOf: bytes)
    guard Darwin.rename(temporary, folder + "/request.json") == 0 else {
        throw CocoaError(.fileWriteUnknown)
    }
}

func preparedLaunchURL(_ channel: NativeLaunchPreparation, original: URL, bundleId: String)
    -> (url: URL?, reason: String?, observation: [String: Any]) {
    let requestId = UUID().uuidString.lowercased()
    var observation: [String: Any] = ["requestId": requestId, "requestedAt": Date().timeIntervalSince1970]
    func unavailable(_ reason: String) -> (url: URL?, reason: String?, observation: [String: Any]) {
        observation["completedAt"] = Date().timeIntervalSince1970
        return (nil, reason, observation)
    }
    guard channel.timeoutMs == 15000, channel.token.utf8.count == 64,
          channel.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        return unavailable("launch_preparation_invalid_channel")
    }
    do {
        try privateLaunchDirectory(channel.directory)
        let folder = channel.directory
        let requestFile = folder + "/request.json"
        _ = try privateLaunchData(requestFile)
        let request: [String: Any] = ["schemaVersion": 1, "token": channel.token, "requestId": requestId, "bundleId": bundleId]
        try writePrivateLaunchRequest(JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]), folder: folder, requestId: requestId)
        let deadline = ProcessInfo.processInfo.systemUptime + Double(channel.timeoutMs) / 1000
        while ProcessInfo.processInfo.systemUptime < deadline {
            try privateLaunchDirectory(channel.directory)
            if let bytes = try privateLaunchData(folder + "/response.json") {
                guard let response = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                    return unavailable("launch_preparation_invalid_response")
                }
                // An earlier cold launch may have left its response; it cannot authorize this new open.
                if response["token"] as? String == channel.token, response["requestId"] as? String == requestId {
                    guard let version = response["schemaVersion"] as? NSNumber,
                          CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1 else {
                        return unavailable("launch_preparation_invalid_response")
                    }
                    if response["status"] as? String == "error" { return unavailable("launch_preparation_failed") }
                    guard response["status"] as? String == "ready", let value = response["launchUrl"] as? String,
                          let url = URL(string: value), let source = URLComponents(url: original, resolvingAgainstBaseURL: false),
                          let target = URLComponents(url: url, resolvingAgainstBaseURL: false), target.scheme != nil,
                          target.scheme?.lowercased() == source.scheme?.lowercased(), target.host?.lowercased() == source.host?.lowercased(),
                          target.port == source.port, target.user == source.user, target.password == source.password else {
                        return unavailable("launch_preparation_invalid_url")
                    }
                    observation["responseAcceptedAt"] = Date().timeIntervalSince1970
                    return (url, nil, observation)
                }
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return unavailable("launch_preparation_timed_out")
    } catch { return unavailable("launch_preparation_io_failed") }
}
// END HOST LAUNCH PREPARATION

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
    struct CaptureProbe: Decodable {
        let nonce: String
        let contextId: String
        let sceneId: String
        let screenAnchor: String
        let outputDir: String
    }
    struct Job: Decodable {
        let bundleId: String
        let screen: String
        let launchArguments: [String]
        let launchUrl: String?
        let launchPreparation: NativeLaunchPreparation?
        let steps: [Step]
        let outputDir: String
        let timeoutMs: Int?
        let launchTimeoutMs: Int?
        let probeSafeArea: Bool?
        let captureProbe: CaptureProbe?
        let orientation: String?
        let rotateAfterSteps: String?
        let preserveSyntheticInputs: [String]?
        let hittableAnchors: [String]?
    }

    func testCapture() throws {
        guard let path = ProcessInfo.processInfo.environment["PROTOFLOW_DRIVER_JOB"] else { return XCTFail("PROTOFLOW_DRIVER_JOB is not set") }
        let job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let output = URL(fileURLWithPath: job.outputDir)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let app = XCUIApplication(bundleIdentifier: job.bundleId)
        let previousOrientation = XCUIDevice.shared.orientation
        var result: [String: Any] = [:]
        var safeArea: [String: Double]? = nil
        var launchPreparationObservation: [String: Any]? = nil
        defer {
            if let safeArea { result["safeArea"] = safeArea }
            if let launchPreparationObservation { result["launchPreparation"] = launchPreparationObservation }
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
                try? data.write(to: output.appendingPathComponent("raw.json"))
            }
            app.terminate()
            if job.orientation != nil || job.rotateAfterSteps != nil { XCUIDevice.shared.orientation = previousOrientation }
        }
        let timeout = Double(job.timeoutMs ?? 10000) / 1000
        // Cold launches (React Native loads its JS bundle) take longer than a step.
        let launchTimeout = Double(job.launchTimeoutMs ?? 60000) / 1000
        if job.launchPreparation != nil && job.launchUrl == nil {
            result = ["status": "NOT_RUN", "reason": "launch_preparation_requires_url"]
            return
        }
        if let orientation = job.orientation { XCUIDevice.shared.orientation = try deviceOrientation(orientation) }
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
        if let probe = job.captureProbe {
            app.launchEnvironment = ["SIYUE_CAPTURE_PROBE_SESSION": probe.nonce, "SIYUE_CAPTURE_PROBE_CONTEXT": probe.contextId,
                "SIYUE_CAPTURE_PROBE_SCENE": probe.sceneId, "SIYUE_CAPTURE_PROBE_SCREEN": probe.screenAnchor]
        }
        if let launchUrl = job.launchUrl {
            // Deep-link apps (Expo Router) cold-start on the route the URL names; launch arguments do not apply.
            guard let url = URL(string: launchUrl) else {
                result = ["status": "FAIL", "reason": "launch URL \(launchUrl) is not a valid URL"]
                return
            }
            if job.captureProbe != nil { app.launch() }
            var urlToOpen = url
            if let channel = job.launchPreparation {
                let prepared = preparedLaunchURL(channel, original: url, bundleId: job.bundleId)
                launchPreparationObservation = prepared.observation
                guard let preparedURL = prepared.url else {
                    result = ["status": "NOT_RUN", "reason": prepared.reason ?? "launch_preparation_failed"]
                    return
                }
                urlToOpen = preparedURL
                launchPreparationObservation?["openStartedAt"] = Date().timeIntervalSince1970
            }
            app.open(urlToOpen)
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
        var responsive: [String: Any]? = nil
        if job.orientation != nil || job.rotateAfterSteps != nil {
            let before = app.windows.firstMatch.frame
            var fields: [(String, String)] = []
            for anchor in job.preserveSyntheticInputs ?? [] {
                let field = element(app, anchor)
                guard field.exists && [.textField, .textView, .searchField].contains(field.elementType) else {
                    result = failure(app, output, "synthetic input is absent or is not a nonsecure text field: \(anchor)")
                    return
                }
                fields.append((anchor, fieldValue(field)))
            }
            if let orientation = job.rotateAfterSteps { XCUIDevice.shared.orientation = try deviceOrientation(orientation) }
            Thread.sleep(forTimeInterval: 0.5)
            let after = app.windows.firstMatch.frame
            let observations: [[String: Any]] = fields.map { anchor, value in
                let field = element(app, anchor)
                return ["anchor": anchor, "beforeLength": value.count, "afterLength": field.exists ? fieldValue(field).count : 0,
                    "preserved": field.exists && fieldValue(field) == value]
            }
            responsive = ["orientation": XCUIDevice.shared.orientation.rawValue, "windowBefore": rect(before), "windowAfter": rect(after),
                "windowSizeChanged": before.size != after.size, "syntheticInputs": observations]
        }
        // Let layout settle after the last step; XCUITest already waits for the app to be idle on each query.
        Thread.sleep(forTimeInterval: 0.3)
        if let probe = job.captureProbe, let reason = requestProbe(probe, phase: "before") {
            result = failure(app, output, reason)
            result["status"] = "NOT_RUN"
            return
        }
        let axStarted = Date().timeIntervalSince1970
        let snapshot = try app.snapshot()
        let axFinished = Date().timeIntervalSince1970
        let screenshotStarted = Date().timeIntervalSince1970
        let screenshot = XCUIScreen.main.screenshot()
        let screenshotFinished = Date().timeIntervalSince1970
        try screenshot.pngRepresentation.write(to: output.appendingPathComponent("device.png"))
        let keyboard = app.keyboards.firstMatch
        result = [
            "status": "PASS",
            "keyboardVisible": keyboard.exists,
            "tree": serialize(snapshot),
            "screenshot": "device.png"
        ]
        if let responsive { result["responsiveObservations"] = responsive }
        if let anchors = job.hittableAnchors {
            result["nativeReachability"] = anchors.map { anchor -> [String: Any] in
                let target = element(app, anchor)
                return ["anchor": anchor, "exists": target.exists, "enabled": target.exists && target.isEnabled,
                    "hittable": target.exists && target.isHittable]
            }
        }
        if let probe = job.captureProbe {
            result["probeTiming"] = ["axStartedAt": axStarted, "axFinishedAt": axFinished,
                "screenshotStartedAt": screenshotStarted, "screenshotFinishedAt": screenshotFinished]
            if let reason = requestProbe(probe, phase: "after") {
                result["status"] = "NOT_RUN"
                result["reason"] = reason
                return
            }
        }
        // A state that ends while typing may keep the keyboard up; the engine leaves its frame out of the comparison.
        if keyboard.exists {
            let frame = keyboard.frame
            result["keyboardFrame"] = ["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height]
        }
    }

    private func deviceOrientation(_ name: String) throws -> UIDeviceOrientation {
        switch name {
        case "portrait": return .portrait
        case "portrait-upside-down": return .portraitUpsideDown
        case "landscape-left": return .landscapeLeft
        case "landscape-right": return .landscapeRight
        default: throw NSError(domain: "ProtoFlowDriver", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid capture orientation"])
        }
    }

    private func rect(_ frame: CGRect) -> [String: Double] {
        ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height]
    }

    /// Host bridge writes only the fixed owned App cache channel; XCTest never opens another App's container.
    private func requestProbe(_ probe: CaptureProbe, phase: String) -> String? {
        let folder = URL(fileURLWithPath: probe.outputDir)
        let sampleId = UUID().uuidString.lowercased()
        let marker: [String: Any] = ["nonce": probe.nonce, "sampleId": sampleId, "phase": phase]
        do {
            let bytes = try JSONSerialization.data(withJSONObject: marker, options: [.sortedKeys])
            let request = folder.appendingPathComponent("probe-request.json")
            try bytes.write(to: request, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: request.path)
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if let bytes = try? Data(contentsOf: folder.appendingPathComponent("probe-ack-\(phase).json")),
                   let ack = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                   ack["nonce"] as? String == probe.nonce, ack["sampleId"] as? String == sampleId {
                    return ack["status"] as? String == "OK" ? nil : "UIKit probe: \(ack["reason"] as? String ?? "bridge failed")"
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
            return "UIKit probe: \(phase) sample timed out"
        } catch { return "UIKit probe: \(error.localizedDescription)" }
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
            if target.elementType == .secureTextField {
                // Secure values cannot be read back; preserve the existing secure-field behavior.
                clear(target)
            } else if let reason = clearPublicly(target, app: app) { return reason }
            if step.action == "fill" { return type(step.value ?? "", into: target, app: app) }
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

    // BEGIN PUBLIC EDIT MENU GEOMETRY: actual menu row and common-container bounds only.
    private func publicEditMenuForwardRow(_ menu: CGRect, _ forward: CGRect, _ container: CGRect) -> Bool {
        guard [menu, forward, container].allSatisfy({ rect in
            [rect.minX, rect.minY, rect.width, rect.height].allSatisfy { $0.isFinite } && rect.width > 0 && rect.height > 0
        }) else { return false }
        let height = max(menu.height, forward.height)
        let overlap = min(menu.maxY, forward.maxY) - max(menu.minY, forward.minY)
        let gap = forward.minX - menu.maxX
        return container.contains(menu) && container.contains(forward) && container.height <= height * 2 &&
            overlap >= min(menu.height, forward.height) * 0.75 && abs(menu.midY - forward.midY) <= height * 0.25 &&
            forward.midX > menu.midX && gap >= -min(menu.width, forward.width) * 0.25 && gap <= height
    }
    // END PUBLIC EDIT MENU GEOMETRY

    /// A page-navigation Forward is unrelated: require the actual menu item and button in one small AX container.
    private func publicEditMenuContainsForward(_ root: XCUIElementSnapshot, menu: XCUIElement, forward: XCUIElement) -> Bool {
        func contains(_ node: XCUIElementSnapshot, type: XCUIElement.ElementType, label: String, frame: CGRect) -> Bool {
            (node.elementType == type && node.label == label && node.frame == frame) ||
                node.children.contains { contains($0, type: type, label: label, frame: frame) }
        }
        if publicEditMenuForwardRow(menu.frame, forward.frame, root.frame),
           contains(root, type: .menuItem, label: menu.label, frame: menu.frame),
           contains(root, type: .button, label: "Forward", frame: forward.frame) { return true }
        return root.children.contains { publicEditMenuContainsForward($0, menu: menu, forward: forward) }
    }

    private func publicEditMenuForward(_ app: XCUIApplication, items: [XCUIElement]) -> XCUIElement? {
        guard !items.isEmpty, let snapshot = try? app.snapshot() else { return nil }
        let candidates = app.buttons.matching(NSPredicate(format: "label == %@", "Forward")).allElementsBoundByIndex.filter { button in
            button.exists && button.label == "Forward" && button.isEnabled && button.isHittable &&
                items.contains { publicEditMenuContainsForward(snapshot, menu: $0, forward: button) }
        }
        return candidates.count == 1 ? candidates[0] : nil
    }

    /// A tap can position the caret in the middle. Select All proves the entire nonsecure value is replaced.
    /// Inspect at most four public menu pages; no progress, ambiguity or an unavailable action fails closed.
    private func clearPublicly(_ field: XCUIElement, app: XCUIApplication) -> String? {
        guard [.textField, .textView, .searchField].contains(field.elementType) else { return "public replacement requires a nonsecure text input" }
        if fieldValue(field).isEmpty { return nil }
        guard field.exists && field.isEnabled && field.isHittable else { return "public replacement input is not reachable" }
        field.press(forDuration: 1.0)
        var selectedAll = false
        var pages = Set<String>()
        for page in 0..<4 {
            let menu = app.menuItems["Select All"].firstMatch
            let button = app.buttons["Select All"].firstMatch
            if menu.waitForExistence(timeout: 4), menu.isEnabled && menu.isHittable {
                menu.tap(); selectedAll = true; break
            }
            if button.waitForExistence(timeout: 2), button.isEnabled && button.isHittable {
                button.tap(); selectedAll = true; break
            }
            let items = app.menuItems.allElementsBoundByIndex.filter { $0.exists && $0.isEnabled && $0.isHittable }
            guard !items.isEmpty else { return "public edit menu is unavailable" }
            let signature = items.map { $0.label }.sorted().joined(separator: "\u{001f}")
            guard pages.insert(signature).inserted else { return "public edit menu did not advance" }
            guard page < 3, let forward = publicEditMenuForward(app, items: items) else { return "public Select All action is unavailable" }
            forward.tap()
        }
        guard selectedAll else { return "public Select All action is unavailable" }
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        return fieldValue(field).isEmpty ? nil : "public Select All did not clear the complete input"
    }

    /// Typing can drop keystrokes on a busy simulator (notably into React Native controlled inputs): read the field
    /// back and retype, character by character, before reporting a failure. Secure fields cannot be read back.
    private func type(_ text: String, into field: XCUIElement, app: XCUIApplication) -> String? {
        field.typeText(text)
        if field.elementType == .secureTextField { return nil }
        for _ in 0..<3 {
            if fieldValue(field) == text { return nil }
            if let reason = clearPublicly(field, app: app) { return reason }
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
