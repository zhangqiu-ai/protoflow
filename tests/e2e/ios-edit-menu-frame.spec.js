import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
test('actual Swift AX frame identity accepts bounded ULP roundoff and rejects movement and invalid components', async () => {
  test.skip(process.platform !== 'darwin', 'Swift CoreGraphics runtime needs macOS; no Simulator is used');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-edit-menu-frame-')));
  try {
    const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
    const marked = source.split('// BEGIN PUBLIC EDIT MENU FRAME IDENTITY:')[1];
    let helper;
    if (marked) {
      helper = marked.split('\n').slice(1).join('\n').split('// END PUBLIC EDIT MENU FRAME IDENTITY')[0];
    } else {
      // Exercise the actual pre-fix comparison for RED; the Node regression requires the integrated helper.
      expect(source).toContain('node.frame == frame');
      helper = 'private func publicEditMenuSameFrame(_ lhs: CGRect, _ rhs: CGRect) -> Bool { lhs == rhs }';
    }
    const main = `
struct FrameCase { let name: String; let left: [CGFloat]; let right: [CGFloat]; let expected: Bool }
func rectangle(_ v: [CGFloat]) -> CGRect { CGRect(x: v[0], y: v[1], width: v[2], height: v[3]) }
func step(_ value: CGFloat, _ count: Int) -> CGFloat {
    var result = value
    for _ in 0..<abs(count) { result = count > 0 ? result.nextUp : result.nextDown }
    return result
}
var cases = [FrameCase(name: "observed-one-ULP-x", left: [30.33333333333335, 290, 129, 69], right: [30.333333333333353, 290, 129, 69], expected: true)]
let exact: [CGFloat] = [30.33333333333335, 290, 129, 69]
cases.append(FrameCase(name: "exact", left: exact, right: exact, expected: true))
cases.append(FrameCase(name: "zero-signed-zero", left: [0, -0.0, 0, -0.0], right: [-0.0, 0, -0.0, 0], expected: true))
for baseline: CGFloat in [30.33333333333335, -30.33333333333335, 0, 1, -1, .leastNormalMagnitude, -.leastNormalMagnitude, .greatestFiniteMagnitude, -.greatestFiniteMagnitude] {
    for component in 0..<4 {
        var left = exact; left[component] = baseline
        for distance in [-5, -4, -1, 0, 1, 4, 5] {
            var right = left; right[component] = step(baseline, distance)
            let expected = right[component].isFinite && abs(distance) <= 4
            cases.append(FrameCase(name: "component-\\(component)-base-\\(baseline)-steps-\\(distance)", left: left, right: right, expected: expected))
        }
        for movement: CGFloat in [-0.001, 0.001, -1.0 / 3, 1.0 / 3] {
            // These physical/point movement tests use ordinary screen coordinates, avoiding large-number rounding.
            var ordinary = exact; ordinary[component] = baseline < 0 ? -30.33333333333335 : 30.33333333333335
            var right = ordinary; right[component] += movement
            cases.append(FrameCase(name: "reject-point-or-one-3x-pixel-movement-\\(component)-\\(movement)", left: ordinary, right: right, expected: false))
        }
    }
}
for component in 0..<4 {
    for invalid: CGFloat in [.nan, .infinity, -.infinity] {
        var changed = exact; changed[component] = invalid
        cases.append(FrameCase(name: "invalid-right-\\(component)-\\(invalid)", left: exact, right: changed, expected: false))
        cases.append(FrameCase(name: "invalid-left-\\(component)-\\(invalid)", left: changed, right: exact, expected: false))
        cases.append(FrameCase(name: "same-invalid-\\(component)-\\(invalid)", left: changed, right: changed, expected: false))
    }
}
let crossed: CGFloat = .leastNonzeroMagnitude * 3
cases.append(FrameCase(name: "opposite-sign-six-ULPs", left: [-crossed, 0, 129, 69], right: [crossed, 0, 129, 69], expected: false))
let failures = cases.compactMap { value -> [String: Any]? in
    let forward = publicEditMenuSameFrame(rectangle(value.left), rectangle(value.right))
    let reversed = publicEditMenuSameFrame(rectangle(value.right), rectangle(value.left))
    return forward == value.expected && reversed == value.expected ? nil : ["name": value.name, "expected": value.expected, "actual": forward, "reversed": reversed]
}
let result: [String: Any] = ["caseCount": cases.count, "failures": failures]
print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
`;
    const file = path.join(root, 'main.swift'), binary = path.join(root, 'policy');
    await writeFile(file, 'import Foundation\nimport CoreGraphics\n' + helper + main);
    await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
    const result = await exec(binary, [], { timeout: 5000 });
    const report = JSON.parse(result.stdout.trim());
    expect(report.caseCount).toBeGreaterThan(400);
    expect(report.failures).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
