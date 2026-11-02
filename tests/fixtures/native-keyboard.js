import { PNG } from 'pngjs';

// Synthetic protocol fixture: actual normalizer/PNG processing, not a claim of device acceptance.
export function nativeKeyboardFixture() {
  const frame = (x, y, width, height) => ({ x, y, width, height });
  const keyboard = { type: 'keyboard', frame: frame(0, 12, 10, 8), children: [
    { type: 'button', identifier: 'editor.keyboard-key', label: 'Go', frame: frame(1, 13, 2, 2) },
  ] };
  const raw = { status: 'PASS', keyboardVisible: true, keyboardFrame: keyboard.frame, safeArea: frame(0, 2, 10, 16),
    tree: { type: 'application', frame: frame(0, 0, 10, 20), children: [
      { type: 'other', identifier: 'editor', frame: frame(0, 2, 10, 16) },
      { type: 'button', identifier: 'editor.save', label: 'Save', frame: frame(1, 9, 2, 2) },
      { type: 'other', identifier: 'editor.behind', frame: frame(0, 14, 10, 2) }, keyboard,
    ] } };
  const image = new PNG({ width: 20, height: 40 }); image.data.fill(255);
  return { raw, png: PNG.sync.write(image), options: {
    anchors: ['editor', 'editor.save', 'editor.behind', 'editor.keyboard-key'], screen: 'editor',
  } };
}

export const fill = { action: 'fill', anchor: 'editor.content', value: 'synthetic content' };
export const locate = [{ action: 'scroll-to', anchor: 'editor.save' }, { action: 'wait-for', anchor: 'editor.save' }];
