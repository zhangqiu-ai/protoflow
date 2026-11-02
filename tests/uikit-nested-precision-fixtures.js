import { measuredTopology } from './uikit-nested-scroll-fixtures.js';
export const find = (root, id) => root.identifier === id ? root : (root.children ?? []).map(node => find(node, id)).find(Boolean);
export function precisionFixture({ height = 155.66666666666674, clipHeight = 155.6666259765625, y = 1024, clipY = y, scale = 3 } = {}) {
  const capture = measuredTopology(), root = capture.windows[0].tree;
  capture.source = 'currentUIKitViewTree'; capture.occlusion = 'notComputed'; capture.windows[0].screenScale = scale;
  Object.assign(find(root, 'test.inner').frameInScreen, { y, height });
  Object.assign(find(root, 'test.viewport-clip').frameInScreen, { y: clipY, height: clipHeight });
  return capture;
}
export const textFacts = (interpret, capture) => {
  const root = capture.windows[0].tree, text = find(root, 'test.text');
  const result = interpret(capture, () => ({}));
  return { eligibility: result.eligibility.get(text), text: result.facts(text).text };
};
