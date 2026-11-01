import { screenScopeFixture } from './uikit-screen-scope-fixtures.js';

// Anonymous actual window/safe-area/main dimensions. No application ID or private text is copied.
export function insetFixture(frame, change = () => {}) {
  return screenScopeFixture(fixture => {
    const { screenAX, screenUIKit } = fixture;
    screenAX.frame = { ...frame };
    Object.assign(screenUIKit, { frameInScreen: { ...frame }, frameInWindow: { ...frame },
      bounds: { x: 0, y: 0, width: frame.width, height: frame.height }, clipIntersection: { ...frame } });
    change(fixture);
  });
}
export const screen = fixture => fixture.result.elements.find(item => item.anchor === 'test.screen');
export const stripTextEvidence = ({ text, provenance, ...facts }) => facts;
