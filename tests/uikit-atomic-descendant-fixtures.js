import { ownershipFixture } from './uikit-text-ownership-fixtures.js';
const find = (node, id) => node.identifier === id ? node : (node.children ?? []).map(child => find(child, id)).find(Boolean);
export const captionFixture = (hidden = false) => ownershipFixture('thumb', fixture => {
  const owner = find(fixture.tree, 'test.thumb');
  const frame = fixture.rect(420, 1040, 100, 20);
  const part = fixture.uikit('test.owned-caption', 'Owned caption', [], frame, { renderEligible: false,
    clipIntersection: fixture.rect(0, 0, 0, 0), observedSemantics: structuredClone(owner.observedSemantics),
    ...(hidden && { hidden: true, ancestorOrSelfHidden: true }) });
  owner.children.push(part);
  find(fixture.rawAX, 'test.action').children.push(fixture.ax('test.owned-caption', 'staticText', 'Owned caption', [], frame));
  fixture.anchors.push('test.owned-caption');
});
