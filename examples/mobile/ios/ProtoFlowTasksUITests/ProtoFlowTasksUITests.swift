import XCTest

/// The app's own functional tests (ProtoFlow `functional` for the ios target).
final class ProtoFlowTasksUITests: XCTestCase {
    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-PROTOFLOW_SCREEN", screen]
        app.launch()
        return app
    }

    func testAddingATaskAppendsItAndClearsTheField() {
        let app = launch("tasks")
        let input = app.textFields["tasks.input"]
        input.tap()
        input.typeText("Write tests")
        app.buttons["tasks.add"].tap()
        XCTAssertEqual(app.staticTexts.matching(identifier: "tasks.item").count, 3)
        XCTAssertTrue(app.staticTexts["Write tests"].exists)
        XCTAssertFalse(app.staticTexts["tasks.error"].exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    func testAddingAnEmptyTaskShowsTheError() {
        let app = launch("tasks")
        app.buttons["tasks.add"].tap()
        XCTAssertTrue(app.staticTexts["tasks.error"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "tasks.item").count, 2)
    }

    func testSettingsSaveAndNavigation() {
        let app = launch("settings")
        app.switches["settings.notify-toggle"].tap()
        app.buttons["settings.save"].tap()
        XCTAssertTrue(app.staticTexts["settings.saved"].waitForExistence(timeout: 5))
        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.staticTexts["tasks.title"].waitForExistence(timeout: 5))
    }
}
