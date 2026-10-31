import { readFileSync } from 'node:fs';
import { controlFixture } from './uikit-probe-control-fixtures.js';

export function otherFixture(change = () => {}) {
  return controlFixture(fixture => {
    fixture.axControl.type = 'other';
    fixture.control.children = [fixture.uikit('', 'Z', [], fixture.rect(20, 100, 40, 20))];
    fixture.control.observedSemantics.buttonTrait = false;
    for (const key of ['rnRole', 'rnDisabled']) { delete fixture.control.observedSemantics[key]; delete fixture.control.observedSemantics.sources[key]; }
    change(fixture);
  });
}

export function buttonParent(fixture, semantics) {
  fixture.axContainer.type = 'button';
  fixture.axContainer.label = 'Profile accessible name';
  fixture.container.observedSemantics = semantics ?? {
    userInteractionEnabled: true, effectiveUserInteractionEnabled: true, buttonTrait: true, linkTrait: false,
    sources: { userInteractionEnabled: 'UIView.userInteractionEnabled', effectiveUserInteractionEnabled: 'currentUIKitAncestorInteraction', buttonTrait: 'UIAccessibilityTraitsButton', linkTrait: 'UIAccessibilityTraitsLink' }
  };
}

export const otherCases = [
  { name: 'an other AX leaf uses nonempty public RN text for itself and its ancestors', text: 'Z' },
  ...['UILabel.text', 'UIButton.currentTitle'].map(textSource => ({ name: `an other AX leaf uses actual ${textSource} without changing role`, text: 'Visible character',
    change({ control }) { Object.assign(control.children[0], { text: 'Visible character', textSource, class: textSource === 'UILabel.text' ? 'UILabel' : 'UIButton' }); } })),
  { name: 'a known other leaf under a corrected button parent keeps the same real character', text: 'Z',
    change: fixture => buttonParent(fixture) },
  { name: 'preexisting own-fact provenance and AX name remain available', text: 'Z',
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').provenance = { source: 'nativeAX', fields: ['text'], note: 'original observation' }; }; } },
  { name: 'empty current subtree does not erase an other AX name', unchanged: true, change({ control }) { control.children = []; } },
  { name: 'whitespace-only public text cannot replace an other AX name', unchanged: true, change({ control }) { control.children[0].text = '   '; } },
  { name: 'an other leaf cannot use its accessibility name as public text', unchanged: true,
    change({ control }) { control.children = []; control.accessibilityLabel = 'Z'; } },
  ...['buttonTrait', 'linkTrait'].map(trait => ({ name: `other AX with current ${trait} conflicts is not corrected`, unchanged: true,
    change({ control }) { control.observedSemantics[trait] = true; } })),
  ...['button', 'link', 'checkbox', 'radio', 'switch'].map(rnRole => ({ name: `other AX with current RN ${rnRole} conflicts is not corrected`, unchanged: true,
    change({ control }) { control.observedSemantics.rnRole = rnRole; control.observedSemantics.sources.rnRole = 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole'; } })),
  { name: 'native input metadata excludes an other leaf', unchanged: true,
    change({ control }) { control.observedSemantics.inputKind = 'switch'; control.observedSemantics.sources.inputKind = 'UIKit.publicType'; } },
  { name: 'editable metadata excludes an other leaf even when false', unchanged: true,
    change({ control }) { control.observedSemantics.editable = false; control.observedSemantics.sources.editable = 'UITextView.editable'; } },
  { name: 'missing current public semantics excludes an other leaf', unchanged: true, change({ control }) { delete control.observedSemantics; } },
  { name: 'an other AX subtree cannot be rewritten as a leaf', unchanged: true,
    change({ axControl, ax, rect }) { axControl.children = [ax('', 'staticText', 'AX caption', [], rect(20, 100, 40, 20))]; } },
  { name: 'an other descendant of an AX image stays outside image correction', unchanged: true, change({ axContainer }) { axContainer.type = 'image'; } },
  { name: 'unconfirmed visibility cannot prove other own text', unchanged: true,
    change({ control }) { control.alpha = 0; control.effectiveAlpha = 0; control.renderEligible = false; control.children = []; } },
  { name: 'a hidden public text child does not become affirmative own text', unchanged: true,
    change({ control }) { Object.assign(control.children[0], { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }); } },
  { name: 'an input descendant is not read or reinterpreted as other text', unchanged: true,
    change({ control, uikit, rect }) { const input = uikit('', '', [], rect(20, 100, 40, 20), { inputRedacted: true, textSource: 'redactedInput' }); delete input.children; control.children = [input]; } },
  { name: 'other frame mismatch fails closed', unchanged: true, change({ axControl }) { axControl.frame = { ...axControl.frame, x: 21 }; } },
  { name: 'duplicate current other identity fails closed', unchanged: true, change({ control, container }) { container.children.push(structuredClone(control)); } },
  { name: 'duplicate raw other identity fails closed', unchanged: true, change({ axControl, axContainer }) { axContainer.children.push(structuredClone(axControl)); } },
  { name: 'ambiguous required ancestor fails the entire other correction group closed', unchanged: true,
    change({ tree, container }) { tree.children.push({ ...structuredClone(container), children: [] }); } },
  { name: 'positive unowned sibling text cannot become other own text', unchanged: true,
    change({ control, container, uikit, rect }) { control.children = []; delete control.accessibilityLabel; container.children.push(uikit('', 'Z', [], rect(20, 100, 40, 20))); } },
  { name: 'duplicate response scope fails the entire other group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => response.elements.push(structuredClone(response.elements.find(item => item.anchor === 'test.container'))); } },
  { name: 'other response role conflict fails the entire group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').role = 'button'; }; } },
  { name: 'other response input type conflict fails the entire group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').inputType = 'password'; }; } },
  { name: 'a response from a different text observation fails the entire group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').text = 'Different observation'; }; } },
];

/** Captured avatar branches with only the account name redacted; the parent validation envelope is synthetic. */
export function observedOtherBranches() {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/uikit-avatar-own-observations.json', import.meta.url), 'utf8'));
  return saved.observations.map(observation => ({ observation, fixture: controlFixture(fixture => {
    Object.assign(fixture.control, structuredClone(observation.uikit));
    Object.assign(fixture.axControl, structuredClone(observation.ax));
    fixture.anchors[fixture.anchors.indexOf('test.action')] = observation.ax.identifier;
    buttonParent(fixture, structuredClone(observation.parentSemantics));
  }) }));
}
