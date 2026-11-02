import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
let binary;
test.skip(process.platform !== 'darwin', 'Swift helper runtime needs the macOS Swift toolchain');
test.beforeAll(async () => {
 const out = await mkdtemp(path.join(tmpdir(), 'scroll-end-swift-shim-'));
 const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
 const fragment = source.split('// BEGIN PUBLIC SCROLL END:')[1].split('\n').slice(1).join('\n').split('// END PUBLIC SCROLL END')[0];
 const mocks = `import Foundation
import CoreGraphics
struct XCUIElementSnapshot { var identifier: String; var children: [XCUIElementSnapshot]; var frame: CGRect }
enum ElementType { case any }
enum Velocity { case slow }
var events: [[String: Double]] = []
class XCUIElement {
 var identifier: String; var frame: CGRect; var children: [XCUIElement] = []; var exists = true; var isHittable = true
 var onDrag: (() -> Void)?
 init(_ id: String, _ rect: CGRect) { identifier = id; frame = rect }
 func snapshot() throws -> XCUIElementSnapshot { XCUIElementSnapshot(identifier: identifier, children: try children.map { try $0.snapshot() }, frame: frame) }
 func coordinate(withNormalizedOffset offset: CGVector) -> Coordinate { Coordinate(self, CGVector(dx: frame.width * offset.dx, dy: frame.height * offset.dy)) }
}
struct Query { var items: [XCUIElement]; func containing(_ type: ElementType, identifier: String) -> Query { self }; var allElementsBoundByIndex: [XCUIElement] { items } }
class XCUIApplication: XCUIElement { var scrollViews = Query(items: []) }
struct Coordinate {
 var element: XCUIElement; var offset: CGVector
 init(_ element: XCUIElement, _ offset: CGVector) { self.element = element; self.offset = offset }
 func withOffset(_ value: CGVector) -> Coordinate { Coordinate(element, CGVector(dx: offset.dx + value.dx, dy: offset.dy + value.dy)) }
 func press(forDuration duration: Double, thenDragTo finish: Coordinate, withVelocity velocity: Velocity, thenHoldForDuration hold: Double) {
  events.append(["x1": element.frame.minX + offset.dx, "y1": element.frame.minY + offset.dy, "x2": finish.element.frame.minX + finish.offset.dx, "y2": finish.element.frame.minY + finish.offset.dy, "duration": duration, "hold": hold])
  element.onDrag?()
 }
}
class Driver { var scrollEndObservations: [[String: Any]] = []
${fragment}
 func run(_ target: XCUIElement, app: XCUIApplication, timeout: Double) -> String? { scrollToEndPublicly(target, app: app, anchor: "demo.export", timeout: timeout) }
}
let name = CommandLine.arguments[1]
let app = XCUIApplication("", CGRect(x: 0, y: 0, width: 320, height: 600))
let scroll = XCUIElement("", CGRect(x: 0, y: 50, width: 320, height: 500))
let target = XCUIElement("demo.export", CGRect(x: 30, y: name == "normal" ? 700 : 200, width: 120, height: 40))
scroll.children = [target]; app.children = [scroll]; app.scrollViews = Query(items: [scroll])
scroll.onDrag = {
 if name == "normal" { target.frame.origin.y = max(200, target.frame.minY - 300) }
 if name == "scopeChanged" { scroll.frame.origin.y += 1 }
 if name == "moving" { target.frame.origin.y -= 1 }
}
if name == "nested" { let outer = XCUIElement("", app.frame); outer.children = [scroll]; app.children = [outer]; app.scrollViews.items.append(outer) }
if name == "duplicate" { app.children.append(XCUIElement("demo.export", target.frame)) }
if name == "foreignLabel" { let foreign = XCUIElement("other", scroll.frame); foreign.children = [XCUIElement("other.export", target.frame)]; app.children.append(foreign); app.scrollViews.items.append(foreign) }
if name == "smallViewport" { scroll.frame.size.width = 20 }
let driver = Driver(); let reason = driver.run(target, app: app, timeout: name == "deadline" ? 0 : 10)
print(String(data: try JSONSerialization.data(withJSONObject: ["reason": reason as Any? ?? NSNull(), "events": events, "observations": driver.scrollEndObservations], options: [.sortedKeys]), encoding: .utf8)!)
`;
 const file = path.join(out, 'main.swift'); binary = path.join(out, 'probe'); await writeFile(file, mocks);
 await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
 // Also typecheck the exact helper against the real iOS Simulator XCTest/UIKit declarations, not the mocks.
 const real = path.join(out, 'real-api.swift');
 await writeFile(real, `import XCTest\nimport UIKit\n@MainActor final class PublicScrollAPI { var scrollEndObservations: [[String: Any]] = []\n${fragment}\n}`);
 const platform = (await exec('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-platform-path'], { timeout: 10000 })).stdout.trim();
 await exec('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-target', 'arm64-apple-ios18.0-simulator', '-F', path.join(platform, 'Developer/Library/Frameworks'), real], { timeout: 60000 });
});
async function run(name) { return JSON.parse((await exec(binary, [name], { timeout: 10000 })).stdout); }
test('actual Swift helper uses bounded public viewport gestures and records unverified endpoint only', async () => {
 for (const name of ['normal', 'foreignLabel', 'blocked', 'moving']) {
  const result = await run(name); expect(result.reason).toBeNull(); expect(result.events.length).toBeGreaterThan(0); expect(result.events.length).toBeLessThanOrEqual(10);
  for (const event of result.events) { expect(event.x1).toBe(160); expect(event.x2).toBe(160); expect(event.y1).toBe(450); expect(event.y2).toBe(150); expect(event.hold).toBe(0.2); }
  expect(result.observations).toHaveLength(1); expect(result.observations[0].endpointVerified).toBe(false);
  if (name === 'moving') expect(result.events).toHaveLength(10);
  if (name === 'blocked') expect(result.events).toHaveLength(2);
 }
});
test('actual Swift helper rejects ambiguous, changed, unavailable or expired gesture scope', async () => {
 for (const [name, reason] of [['nested', /one scroll ancestor/], ['duplicate', /unique exact target/], ['scopeChanged', /scope changed/], ['smallViewport', /unobstructed app scroll viewport/], ['deadline', /deadline/]]) {
  const result = await run(name); expect(result.reason).toMatch(reason); expect(result.observations).toHaveLength(0); expect(result.events.length).toBeLessThanOrEqual(1);
 }
});
