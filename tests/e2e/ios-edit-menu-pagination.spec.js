import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
test('edit menu row geometry accepts the observed Select/Forward menu and rejects unrelated navigation', async () => {
  test.skip(process.platform !== 'darwin', 'Swift Foundation policy runtime needs macOS; no Simulator is used');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-edit-menu-policy-')));
  try {
    const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
    const helper = source.split('// BEGIN PUBLIC EDIT MENU GEOMETRY:')[1].split('\n').slice(1).join('\n').split('// END PUBLIC EDIT MENU GEOMETRY')[0];
    // Measured from the real iOS edit-menu RED: Select menuItem and adjacent Forward under the small row container.
    const menu = [88.25, 163, 129, 69], forward = [215.25, 167, 61, 61], container = [33.25, 163, 297.5, 69];
    const cases = [
      { menu, forward, container, expected: true },
      { menu, forward: [215.25, 90, 61, 61], container, expected: false },
      { menu, forward: [300, 167, 61, 61], container: [0, 163, 375, 69], expected: false },
      { menu, forward: [20, 167, 61, 61], container, expected: false },
      { menu, forward, container: [0, 0, 375, 667], expected: false },
      { menu, forward, container: [84.25, 163, 181.5, 69], expected: false },
      { menu: [88.25, 163, 129, 0], forward, container, expected: false },
      { menu, forward: [160, 167, 61, 61], container, expected: false },
      { menu, forward: [215.25, 210, 61, 61], container: [33.25, 163, 297.5, 110], expected: false },
    ];
    const serialized = JSON.stringify(cases);
    const main = `\nlet data = "${Buffer.from(serialized).toString('base64')}"\nlet cases = try JSONSerialization.jsonObject(with: Data(base64Encoded: data)!) as! [[String: Any]]\nfunc rectangle(_ values: Any) -> CGRect { let n = values as! [Double]; return CGRect(x:n[0],y:n[1],width:n[2],height:n[3]) }\nprint(cases.map { publicEditMenuForwardRow(rectangle($0["menu"]!), rectangle($0["forward"]!), rectangle($0["container"]!)) })\n`;
    const file = path.join(root, 'main.swift'), binary = path.join(root, 'policy');
    await writeFile(file, 'import Foundation\nimport CoreGraphics\n' + helper + main);
    await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
    const result = await exec(binary, [], { timeout: 5000 });
    expect(JSON.parse(result.stdout.trim())).toEqual(cases.map(value => value.expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});
