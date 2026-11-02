import { readFileSync } from 'node:fs';
import { controlFixture } from './uikit-probe-control-fixtures.js';
const observations = JSON.parse(readFileSync(new URL('./uikit-text-ownership-observations.json', import.meta.url), 'utf8'));
export function ownershipFixture(kind, change = () => {}) {
  return controlFixture(fixture => {
    const observed = structuredClone(observations[kind]);
    Object.assign(fixture.tree, observed.uikit);
    Object.assign(fixture.rawAX, observed.ax);
    fixture.anchors.splice(0, fixture.anchors.length, ...observed.anchors);
    Object.assign(fixture, { content: observed.content, windowFrame: observed.windowFrame });
    change(fixture);
  });
}
export const fact = (fixture, id) => fixture.result.elements.find(item => item.anchor === id);
