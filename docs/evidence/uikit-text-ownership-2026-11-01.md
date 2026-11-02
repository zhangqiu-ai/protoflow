# Correlated UIKit text ownership: external candidate evidence

This page preserves the external v2 candidate before the separately reviewed nested-scroll and atomic-descendant integration. Its original source/result scope remains historical; see the [local integration record](../uikit-reviewed-integration-2026-11-01.md) for the combined source and remaining Native limits.

This candidate keeps the real correlated UIKit subtree instead of flattening its text into a second AX tree. Only unique, frame/role-correlated, noninput scopes with original observation checks may replace text. Existing blocked groups, image-caption coherence, input exclusion and unowned/ambiguous flattened geometry stay closed. Matching text retains prior provenance.

Rendered-hierarchy ordering is opt-in. It orders only the original subtree text parts, retaining every node reference. Empty branches cannot perturb order; an absolute wrapper enclosing a text-bearing sibling is placed by its own real text/scroller extent. Ordinary ring rows keep their actual wrapper frame. Ancestor aggregate labels can be excluded only on the explicitly opted-in path; default AX behavior is unchanged.

Five anonymous reduced fixtures retain the original public geometry and direct-parent order from saved captures: row/ring, usage labels, footer/Tabbar, offscreen thumbnail, and a flattened data-path region. They contain synthetic text and identifiers, no input values, actual build identity, session or private profile. An external proof checks all retained public numeric/semantic fields and parent/order against the originals.

Actual evidence:

- Final identical Node tests on the v1 source: 17 tests, 11 PASS / 6 FAIL, including the five counterexamples and the ancestor-option contract.
- Same source candidates: 234 affected pure Node tests PASS, plus 9 default native-tree/iosResponse tests PASS.
- Playwright: five reliable original-source failures; final 64 tests PASS, workers 1, retries 0. Separate original-failure and final traces remain intact.
- First affected attempt retained 24 regression failures. Guard/provenance fixes closed them; the original logs remain.
- One combined test command failed in an external harness CLI smoke test because the minimal copy lacked its CLI script. No Native capture ran; that log remains. The final checks explicitly use pure Node cases.
- Read-only interpretation of five complete original scenes confirms ring/container order, usage and footer order, thumbnail ancestor exclusion, and local path ownership. This does not recompute required tiers or accept a new Native run.

The original nested-scroll eligibility block is byte-identical. Offscreen nested-scroll physical text remains unsupported and is not promoted. Actual missing delete identity, notification UI, missing contract anchors and numbered-list serialization are outside this patch. Original 41 required-tier failures, v1 evidence, SDK source and App source remain preserved. Root owns integration and Native acceptance.
