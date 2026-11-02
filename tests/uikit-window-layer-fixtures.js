import { screenScopeFixture } from './uikit-screen-scope-fixtures.js';

// Generic synthetic two-column UI. Full-window anonymous hosts carry no text/identifier or inferred overlay role.
export function windowLayerFixture({ popup = true, offscreen = false, secondPopup = false } = {}, change = () => {}) {
  return screenScopeFixture(fixture => {
    const { tree, uikit, rect } = fixture;
    const full = rect(0, 0, 1210, 834);
    tree.children[0] = uikit('', '', [tree.children[0]], full);
    const body = uikit('test.body', 'Body paragraph', [], rect(340, offscreen ? 900 : 300, 700, 24),
      offscreen ? { renderEligible: false, clipIntersection: rect(0, 0, 0, 0) } : {});
    tree.children[1].children.push(uikit('', '', [body], rect(320, 120, 870, 620), { class: 'UIScrollView', clipsToBounds: true,
      scrollGeometry: { source: 'UIScrollView.publicGeometry', isScrollView: true, scrollEnabled: true,
        contentOffset: { x: 0, y: 0 }, contentSize: { width: 870, height: 1100 }, contentInset: { top: 0, left: 0, bottom: 0, right: 0 } } }));
    const popupHost = (title, button) => uikit('', '', [uikit('', '', [uikit('', '', [], full),
      uikit('', '', [uikit('', title, [], rect(399, 220, 412, 28)), uikit('', button, [], rect(399, 500, 412, 44))], rect(375, 180, 460, 400))], full)], full);
    if (popup) tree.children.push(popupHost('Dialog title', 'Continue'));
    if (secondPopup) tree.children.push(popupHost('Second dialog', 'Confirm'));
    Object.assign(fixture, { sidebar: tree.children[0].children[0], scroll: tree.children[1].children.at(-1),
      popup: popup ? tree.children[2] : null });
    change(fixture);
  });
}

export const windowText = fixture => fixture.result.elements.find(item => item.anchor === 'test.screen').text;
export const backgroundText = 'Profile Search Settings Visible heading Body paragraph';

export const partialWindowFrames = {
  left: { frame: { x: -600, y: 220, width: 800, height: 24 }, clip: { x: 0, y: 220, width: 200, height: 24 } },
  right: { frame: { x: 1100, y: 220, width: 800, height: 24 }, clip: { x: 1100, y: 220, width: 110, height: 24 } },
  top: { frame: { x: 100, y: -600, width: 200, height: 800 }, clip: { x: 100, y: 0, width: 200, height: 200 } },
  bottom: { frame: { x: 100, y: 780, width: 200, height: 800 }, clip: { x: 100, y: 780, width: 200, height: 54 } },
};
export function partialWindowFixture(side, change = () => {}) {
  return windowLayerFixture({ popup: false }, fixture => {
    const geometry = partialWindowFrames[side];
    const partial = fixture.uikit('test.partial', 'Partly visible', [], { ...geometry.frame }, { clipIntersection: { ...geometry.clip }, renderEligible: true });
    fixture.sidebar.children.push(partial);
    change(partial, fixture);
  });
}
