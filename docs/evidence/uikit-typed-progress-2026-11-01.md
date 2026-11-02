# Typed nontext progress evidence — external candidate, 2026-11-01

The current saved image-generating body includes the accessibility-only name of a spinner. Its actual UIKit node has an accessibility label, no public physical text source, and an image child; the screenshot shows the spinner icon without those words. The frozen prototype spinner is an empty span with CSS border animation. The direct physical-text correction currently refuses the body because three selected AX contributors are anonymous. This conservative fallback is retained until all contributors can be correlated with trustworthy evidence.

## Scope and collector choice

The candidate adds one optional raw AX observation when the actual immutable XCUITest snapshot reports `elementType == .activityIndicator`:

```json
{"observedNonTextKind":{"kind":"activityIndicator","source":"XCUIElementSnapshot.elementType"}}
```

The original normalized type remains `other`; identifier, label, enabled/selected state, frames, value/placeholder handling and every child remain unchanged. The public enum exists in the installed XCUIAutomation header. No UIKit/App collector or App flag changes are needed. A UIKit collector alternative would need an App probe change and a new immutable App build; by itself it would also leave the original AX native type unobserved. The single AX collector is the smaller observation proposed for this candidate: AX supplies the original native activity category, while UIKit supplies independently observed noninput semantics, current physical geometry and true ancestry. UIKit does not independently add an activity-kind field in this option; Root must review that trust boundary. It still needs a future real XCUITest capture: the existing capture normalized the original native type away, so this candidate does not assert that the actual spinner will emit the new metadata. If it does not, the original FAIL remains.

## Correlation rules

The existing opt-in `supplementUIKitFacts` path and all outer unique ID/frame/role/count/window/privacy/blocked-group gates remain. Every selected contributor of the affected scope must correlate; one unknown contributor keeps the original AX fallback.

An anonymous static-text contributor requires one unique anonymous current UIKit public physical-text source with exactly the original literal text and complete frame. An anonymous nontext contributor additionally needs the trusted AX observation above, original AX role `other`, an AX leaf, a unique literal accessibility-label/full-frame match, current typed noninteractive/noneditable/noninput semantics, and no public physical-text or input node in its actual UIKit subtree. `textSource: none` alone is insufficient. The collector's public native category is the evidence; no class name, product anchor or expected word is used as a condition.

Both kinds must belong beneath the same nearest uniquely identified AX/UIKit owner with exact frame, trusted noninput semantics and actual ancestry beneath the requested scope. Every observed anonymous AX parent must have exactly one order-preserving full-frame/role mapping in the actual UIKit ancestor chain. Distinct contributors cannot reuse one current node. Zero or multiple mappings fail closed. Mapping counts are capped at two using bounded dynamic programming over the existing depth-limited chains, avoiding combinatorial search. A long unmatched chain remains rejected. Every candidate and matched parent must be rendered. Complete current ancestor chains must be attached, unhidden, positive alpha, untransformed and noninput. Supported physical child text is never classified as an accessibility-only name. New correlation provenance records original AX/current UIKit and owner node paths.

The actual raw trees are not pruned, rewritten or relabeled. Only a fully proved scope's derived text is corrected, using the existing physical UIKit interpretation. Bounds, semantic/interaction facts, capture comparisons, tiers, thresholds, configuration and expected text are unchanged. Missing metadata, unknown custom contributor, missing current semantics, wrong source/category/role/frame/owner, duplicate identity/geometry, ambiguous parent chain, hidden/transformed/input nodes remain refused.

## Repeatable evidence

All commands ran only in the external SDK copy. Original c4 sources remain unchanged. The final exact same Node tests on original sources report **20 PASS / 3 FAIL**: two physical-text corrections and actual Swift serialization metadata. On the candidate, the affected Node suites report **154 PASS / 0 FAIL**, including all **23 new tests** and the Foundation-only source serialization test.

The Swift protocol test extracts the actual unchanged `typeName` and candidate `serialize` methods and executes them with Foundation and snapshot/enum/frame shims. It proves serialization shape, preserved normalized type/label/frame/children and absence of metadata on other kinds. It does not instantiate XCTest/UIKit or prove the actual App spinner's native type. The first frame shim using CGRect did not compile in this harness; its test source and failed logs are preserved. The corrected plain frame shim supplies exactly the members that the original source reads. Only the later metadata assertion failure is reliable RED.

The final true Chromium Playwright counter uses a real DOM progress indicator whose accessible name remains available while its element has no text. It compares the complete region `innerText` directly, without regex/whitespace normalization, to the physical interpretation. On original sources: **18 PASS / 1 FAIL**; on the candidate: **19 PASS / 0 FAIL**. Every refusal counter retains its accessible name and remains different from the DOM physical text. This is a generic DOM/interpretation comparison, not a screenshot or Native acceptance. The external file-scoped runner config uses one worker, zero retries, real installed Chromium, preserved failure screenshots/traces and distinct output directories. Existing repository Playwright discovery already includes the new spec; the external diagnostic config is not a production change.

Commands:

```sh
node --test tests/uikit-probe.test.js tests/uikit-probe-control-text.test.js tests/uikit-probe-image-text.test.js tests/uikit-probe-other-text.test.js tests/uikit-text-ownership.test.js tests/uikit-atomic-descendant.test.js tests/uikit-typed-progress.test.js tests/uikit-typed-progress-serialization.test.js
node node_modules/@playwright/test/cli.js test -c playwright.typed-progress.config.js --output=../pw-source-faithful-green-results
node scripts/check.js
```

Static validation passed: 243 JavaScript files, six published schemas and eight configs. Existing Node control/image/other/ownership/atomic/strict-pair cases pass. Earlier initial fixture references, a hidden-state setup and a physical-child label expectation were wrong; those initial failures and source copies are preserved, are identified as harness corrections, and are not counted as reliable RED. A pre-creation working-directory invocation did not start; its note is retained. Previous DOM whitespace-normalized harness outputs are preserved; the final direct-innerText counter supersedes them.

## Preservation and limits

The original `uikit-probe.js` prefix before `supplementUIKitFacts`, including strict pair validation, semantic validation, control atomic correction and owned-window correction, is byte-identical. The Swift source is byte-identical after removing the single three-line observation block. Other tracked SDK files are unchanged in both the candidate and actual SDK. No private actual tree was added to a repository fixture. All old failure evidence and the running canonical 816 source remain untouched.

Native/generic UIKit runtime observation, actual XCUITest typed emission for the App, actual formal acceptance and current-816 rerun: **NOT_RUN**. The current source still lacks the observation and its existing finding remains FAIL. Root owns final architecture/security review and any later integration or Native authorization.
