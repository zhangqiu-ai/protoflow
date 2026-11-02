import { readFileSync } from 'node:fs';
import { controlFixture } from './uikit-probe-control-fixtures.js';

export function imageFixture(change = () => {}) {
  return controlFixture(fixture => {
    fixture.axControl.type = 'image';
    fixture.control.class = 'UIImageView';
    fixture.control.children = [];
    const facts = fixture.control.observedSemantics;
    facts.buttonTrait = false;
    for (const key of ['rnRole', 'rnDisabled']) { delete facts[key]; delete facts.sources[key]; }
    change(fixture);
  });
}

export function imageCaptionConflictFixture() {
  return imageFixture(({ axControl, control, ax, uikit, rect }) => {
    const frame = rect(20, 100, 40, 20);
    axControl.children = [ax('', 'staticText', 'AX caption A', [], frame)];
    control.children = [uikit('', 'UIKit caption B', [], frame, { class: 'UILabel', textSource: 'UILabel.text' })];
  });
}

export const imageCases = [
  { name: 'image alt is AX semantics, not visible subtree text', text: '' },
  { name: 'a real UILabel within an image remains visible text', text: 'Physical caption',
    change({ control, uikit, rect }) { control.children = [uikit('', 'Physical caption', [], rect(20, 100, 40, 20), { class: 'UILabel', textSource: 'UILabel.text' })]; } },
  { name: 'a real RN paragraph within an image remains visible text', text: 'Z',
    change({ control, uikit, rect }) { control.children = [uikit('', 'Z', [], rect(20, 100, 40, 20))]; } },
  ...['button', 'link', 'checkbox', 'radio', 'switch'].map(rnRole => ({
    name: `image AX with current RN ${rnRole} semantics is not corrected`, unchanged: true,
    change({ control }) { control.observedSemantics.rnRole = rnRole; control.observedSemantics.sources.rnRole = 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole'; }
  })),
  ...['buttonTrait', 'linkTrait'].map(trait => ({ name: `image AX with current ${trait} is not corrected`, unchanged: true,
    change({ control }) { control.observedSemantics[trait] = true; } })),
  { name: 'image AX with current native switch semantics is not corrected', unchanged: true,
    change({ control }) { control.observedSemantics.inputKind = 'switch'; control.observedSemantics.sources.inputKind = 'UIKit.publicType'; } },
  { name: 'missing public semantics cannot prove an empty image subtree', unchanged: true,
    change({ control }) { delete control.observedSemantics; } },
  { name: 'nonvisible current image cannot prove empty visible text', unchanged: true,
    change({ control }) { control.alpha = 0; control.effectiveAlpha = 0; control.renderEligible = false; } },
  { name: 'an image with an input descendant is never read or corrected', unchanged: true,
    change({ control, uikit, rect }) {
      const input = uikit('', '', [], rect(20, 100, 20, 20), { inputRedacted: true, textSource: 'redactedInput' });
      delete input.children; control.children = [input];
    } },
  { name: 'an image cannot borrow an unrelated flattened sibling caption', unchanged: true,
    change({ control, container, uikit, rect }) { delete control.accessibilityLabel; container.children.push(uikit('', 'Unowned caption', [], rect(20, 100, 40, 20))); } },
  { name: 'duplicate current image identity fails closed', unchanged: true,
    change({ control, container }) { container.children.push(structuredClone(control)); } },
  { name: 'mismatched image geometry fails closed', unchanged: true,
    change({ axControl }) { axControl.frame = { ...axControl.frame, x: 21 }; } },
  { name: 'ambiguous affected image ancestor fails the whole correction group closed', unchanged: true,
    change({ tree, container }) { tree.children.push({ ...structuredClone(container), children: [] }); } },
  { name: 'image response role conflict fails the whole correction group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').role = 'button'; }; } },
];

/** An unconfirmed sibling used to replace its subtree, leaving an unmapped requested descendant. */
export function unconfirmedSiblingFixture() {
  return controlFixture(({ container, axContainer, anchors, control, uikit, ax, rect }) => {
    const frame = rect(200, 100, 40, 40);
    const thumb = uikit('test.unconfirmed.thumb', '', [], frame, { alpha: 1, effectiveAlpha: 0, renderEligible: false });
    const unconfirmed = uikit('test.unconfirmed', '', [thumb], frame, {
      alpha: 0, effectiveAlpha: 0, renderEligible: false, observedSemantics: structuredClone(control.observedSemantics)
    });
    container.children.push(unconfirmed);
    axContainer.children.push(ax('test.unconfirmed', 'button', 'Unconfirmed accessible label', [ax('test.unconfirmed.thumb', 'other', '', [], frame)], frame));
    anchors.push('test.unconfirmed', 'test.unconfirmed.thumb');
  });
}

/** Exact recorded branches in a synthetic validation envelope; no private account/profile data is stored. */
export function observedBranches() {
  const saved = JSON.parse(readFileSync(new URL('./fixtures/uikit-image-icon-observations.json', import.meta.url), 'utf8'));
  return saved.observations.map(observation => ({ observation, fixture: controlFixture(fixture => {
    Object.assign(fixture.control, structuredClone(observation.uikit));
    Object.assign(fixture.axControl, structuredClone(observation.ax));
    fixture.anchors[fixture.anchors.indexOf('test.action')] = observation.ax.identifier;
  }) }));
}
