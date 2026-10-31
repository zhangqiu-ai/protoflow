import { controlFixture } from './uikit-probe-control-fixtures.js';

export const screenContent = { x: 0, y: 32, width: 1210, height: 782 };
export const screenMain = { x: 300, y: 32, width: 910, height: 782 };

// Anonymous synthetic envelope preserves the observed dock/main sibling arrangement and frames, not private text.
export function screenScopeFixture(change = () => {}) {
  return controlFixture(fixture => {
    const { tree, rawAX, container, axContainer, uikit, ax, rect } = fixture;
    const shiftAX = node => { node.frame = { ...node.frame, x: node.frame.x + 300, y: node.frame.y + 32 }; for (const child of node.children ?? []) shiftAX(child); };
    const shiftUIKit = node => { node.frameInScreen = { ...node.frameInScreen, x: node.frameInScreen.x + 300, y: node.frameInScreen.y + 32 }; node.frameInWindow = { ...node.frameInScreen }; node.clipIntersection = { ...node.frameInScreen }; for (const child of node.children ?? []) shiftUIKit(child); };
    shiftAX(axContainer); shiftUIKit(container);
    const screenAX = ax('test.screen', 'other', '', [], { ...screenMain });
    const screenUIKit = uikit('test.screen', '', [], { ...screenMain });
    screenUIKit.observedSemantics = { userInteractionEnabled: true, effectiveUserInteractionEnabled: true, buttonTrait: false, linkTrait: false,
      sources: { userInteractionEnabled: 'UIView.userInteractionEnabled', effectiveUserInteractionEnabled: 'currentUIKitAncestorInteraction', buttonTrait: 'UIAccessibilityTraitsButton', linkTrait: 'UIAccessibilityTraitsLink' } };
    const sidebarText = [['Profile', rect(20, 40, 200, 24)], ['Search', rect(20, 110, 200, 24)], ['Settings', rect(20, 760, 200, 24)]];
    const sidebar = uikit('test.sidebar', '', sidebarText.map(([text, frame]) => uikit('', text, [], frame)), rect(0, 0, 300, 834));
    const sidebarAX = ax('test.sidebar', 'other', '', sidebarText.map(([text, frame]) => ax('', 'staticText', text, [], frame)), rect(0, 0, 300, 834));
    Object.assign(tree, uikit('', '', [sidebar, uikit('', '', [screenUIKit, container], { ...screenMain })], rect(0, 0, 1210, 834), { class: 'UIWindow' }));
    Object.assign(rawAX, ax('', 'application', '', [ax('', 'window', '', [sidebarAX, ax('', 'other', '', [screenAX, axContainer], { ...screenMain })], rect(0, 0, 1210, 834))], rect(0, 0, 1210, 834)));
    Object.assign(fixture, { screenAX, screenUIKit: tree.children[1].children[0], sidebar: tree.children[0], sidebarAX,
      container: tree.children[1].children[1], control: tree.children[1].children[1].children[1], content: screenContent, windowFrame: rect(0, 0, 1210, 834) });
    change(fixture);
  });
}
