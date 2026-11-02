# UIKit flattened leaf parent scope

2026-11-01. Baseline: local SDK `29fbc9d9df640aaf7acefefd1e41bed6eac5e5c6`.

The change is restricted to the opt-in UIKit rendered-text interpreter. A flattened leaf searches its actual public parent subtree for sibling text and descendants of sibling groups. Scroll ordering is derived within that subtree only when geometry is needed. Eligibility still comes from the original complete public scroll geometry. Screen text retains the whole owned-window layered interpretation. The default AX/native-tree interpreter is unchanged.

The original compact large-note capture had a strict stable pair: 144 nodes before and after. Its flattened note accidentally selected an offscreen Paragraph in the background Thread scroll branch. That unrelated text overlapped the note's offscreen grab handle and triggered the existing ambiguity guard. Bounding the candidates fixes the incorrect ownership before that guard; the guard is preserved.

## Persistent verification

- `tests/fixtures/uikit-flat-note-public.json` retains 48 necessary public nodes/ancestor geometry from that original capture. All text and accessible names are synthetic. It contains no input node/value, launch URL, QA code, account name, or credential. The original full capture remains external and unchanged.
- `tests/uikit-flat-scope.test.js` and the existing Node Playwright `tests/e2e/uikit-control-text.spec.js` reproduce the reduced original failure and the independent background-text borrowing counterexample before the source fix. Confirmed RED: 2 Node failures and 2 Playwright failures. One earlier partial-overlap fixture was actually strictly nested; that harness error was corrected before the confirmed RED and its original logs were preserved.
- GREEN: all 228 related Node cases and all 62 related Playwright cases (46 control/image/other, 2 screen scope, 14 window/default controls). Counts include the new 14 Node and 13 Node Playwright cases; they are not additional distinct totals.
- Positive cases retain same-parent siblings, nested groups/containers, supported offscreen scroll content, and full-window screen text. Negative cases preserve input exclusion, genuine overlapping/sameRect ambiguity, transformed geometry, nonfinite observations, and the original default native-tree behavior. Existing scroll tests retain unsupported nested-scroll and local-clip rejection.

Commands:

```sh
node --test tests/uikit*.test.js tests/native*.test.js tests/ios-driver.test.js tests/ios-launch-preparation.test.js
node node_modules/playwright/cli.js test --config tests/uikit-probe-playwright.config.js --output '<new private output>'
node node_modules/playwright/cli.js test --config tests/uikit-screen-scope-playwright.config.js --output '<new private output>'
node node_modules/playwright/cli.js test --config tests/uikit-window-layers-playwright.config.js --output '<new private output>'
```

These Playwright regressions execute the actual public driver interpreter in Node; existing browser cases retain their original coverage. None is new XCTest, UIKit runtime, provider, or product acceptance.

## Original capture replay and remaining finding

External evidence is frozen under `/tmp/siyue-uikit-parent-scope-fix-cgejsrx4/`, including source hashes, RED/GREEN logs, replay code, original-input hashes, and the exact patch/manifest.

- Original compact pair: unchanged strict validator PASS; old full supplement NOT_RUN, new supplement PASS with five requested facts and no missing anchor.
- Original selected `change-delete` pair: 254 nodes remain stable and strict validation passes. Both old and new full supplement still reject a different, genuine same-parent ambiguity. Two empty flattened leaves have exactly the same frame; no public child ownership distinguishes the selected Paragraph. This patch does not claim to resolve it or weaken that guard.
- Earlier retry samples and `change-delete-confirm` retain stable capture trees, but their corresponding original raw AX/timing was overwritten or removed by an unfinished retry. Only capture-only interpretation is reported; no full-pipeline or native success is inferred.

Swift AX preparation, measured capture block, public edit-menu/launch helpers, `uikit-probe.js`, raw validators, geometry, comparison tiers, and default `native-tree.js` remain byte-identical. No class, application identifier, expected text, styling, or prototype relationship determines ownership. No retry, timeout, node exemption, or threshold was added.

New SDK Native acceptance is **NOT_RUN**. Root must review the source and remaining same-parent finding before any separately authorized runtime verification or local commit.
