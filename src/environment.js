/*
 * Signatures of failures that come from the machine rather than from the version under work: a login that expired, a
 * network that cannot be reached, a build tool that fell back to a path this machine cannot take. Another repair
 * attempt cannot fix any of them. Kept in one place so a newly seen signature is added once (docs/git-runner.md).
 */

/** An expired or missing login of an executor provider. */
const LOGIN = [
  /OAuth|session expired|not logged in|log ?in again|please run \/login|Failed to authenticate|authentication (?:failed|required)/i,
  /invalid (?:x-)?api[ -]?key|\b401\b|Unauthorized/i
];

/** A network that cannot be reached at all: DNS, a refused connection, a proxy tunnel. */
const UNREACHABLE = [
  /Could not resolve host|Temporary failure in name resolution|getaddrinfo|network is unreachable|CONNECT tunnel failed/i,
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/
];

/**
 * A connection that dropped or timed out half way. For an executor these are provider hiccups that the same attempt
 * retries (runner TRANSIENT_PROVIDER); for a build that downloads dependencies they are the machine's network.
 */
const FLAKY = [
  /SSL_connect|SSL_ERROR_SYSCALL|Connection reset by peer|\bECONNRESET\b|\bETIMEDOUT\b|Recv failure|Failed to connect to|Connection timed out|Could not connect to the server/i
];

/**
 * Build tools that silently fall back to a path this machine cannot take. React Native's hermes-engine podspec checks
 * the prebuilt tarball on Maven once, without retrying; when that check fails it builds Hermes from source, which needs
 * cmake. HERMES_ENGINE_TARBALL_PATH (a local tarball) skips the check.
 */
const FALLBACKS = [
  { pattern: /Unable to locate the executable `?cmake`?/i, hint: 'hermes-engine fell back to a source build after its Maven check failed; set HERMES_ENGINE_TARBALL_PATH to a local tarball or check the network to Maven' }
];

/**
 * A simulator or emulator that did not serve the test run: XCUITest could not bootstrap its runner on a busy
 * simulator, the device went away. The version's tests never ran, so they did not fail.
 */
const DEVICE = [
  /operation never finished bootstrapping|Test crashed with signal \w+ while preparing to run tests/i,
  /Test runner never began executing tests|Lost connection to the test manager service|Unable to boot (?:the )?(?:Simulator|device)|Failed to (?:install or launch the test runner|prepare device)/i,
  /\bdevice offline\b|no devices\/emulators found|device '[^']*' not found/i
];

/** A test that ran and failed: then the run is the version's, whatever the device printed besides. */
const TEST_FAILED = /\bTest Case\b.*\bfailed\b|: error: -\[|XCTAssert\w* failed|with [1-9]\d* failures?\b|\btests? completed, [1-9]\d* failed\b|FAILURES!!!/i;

const any = patterns => new RegExp(patterns.map(pattern => pattern.source).join('|'), patterns.some(pattern => pattern.flags.includes('i')) ? 'i' : '');

/** An execution that failed because of the machine (login or unreachable network). */
export const EXECUTOR_ENVIRONMENT = any([...LOGIN, ...UNREACHABLE]);

/**
 * Build output that reports a failure although the command exited 0. Expo prebuild prints a warning and exits 0 when
 * pod install fails, so the workspace it should have produced is missing at the next step.
 */
export const SWALLOWED_BUILD_FAILURES = [/Something went wrong running `pod install`/];

/**
 * Files that cannot change what the build produced or what the screens show: test suites, their fixtures, mocks and
 * runner configs, and documentation. A repair that only touched these leaves the build and the scene evidence of the
 * previous verification valid, so verify may reuse them (workflow.js); functional tests always run again, since they
 * are what such a repair changed.
 */
export const TEST_ONLY_FILES = /(?:^|\/)(?:tests?|__tests__|e2e|specs?|__mocks__|__snapshots__)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:md|txt)$|(?:^|\/)(?:jest|vitest|playwright)\.config\.[^/]+$/;

/** Files a repair can break the build through; a failure after such a change is the version's, not the machine's. */
export const BUILD_INPUTS = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|app\.json|app\.config\.[cm]?[jt]s|Podfile(?:\.lock|\.properties\.json)?|metro\.config\.[cm]?[jt]s|[^/]+\.podspec)$|(?:^|\/)(?:ios|android)\//;

/** The tail of a build's output that the signatures are matched against. */
const TAIL = 20000;

/**
 * The first output line of a failed build that names the machine, with a hint when one is known; null otherwise.
 * Matches stdout and stderr line by line, so the evidence is the line itself.
 */
export function buildEnvironment(result) {
  const lines = [result?.stderr, result?.stdout, result?.error].filter(Boolean).flatMap(text => String(text).slice(-TAIL).split('\n'));
  for (const line of lines) {
    const fallback = FALLBACKS.find(item => item.pattern.test(line));
    if (fallback) return { line: line.trim().slice(0, 500), hint: fallback.hint };
    if ([...UNREACHABLE, ...FLAKY].some(pattern => pattern.test(line))) return { line: line.trim().slice(0, 500) };
  }
  return null;
}

/** The first output line of a failed test run that shows its simulator or emulator did not serve it, or null. */
export function deviceEnvironment(result) {
  const lines = [result?.stderr, result?.stdout, result?.error].filter(Boolean).flatMap(text => String(text).slice(-TAIL).split('\n'));
  if (lines.some(item => TEST_FAILED.test(item))) return null;
  const line = lines.find(item => DEVICE.some(pattern => pattern.test(item)));
  return line ? { line: line.trim().slice(0, 500) } : null;
}

/** The output line that shows a swallowed build failure, or null. */
export function swallowedFailure(result) {
  for (const text of [result?.stdout, result?.stderr]) {
    const lines = String(text ?? '').split('\n');
    const at = lines.findIndex(line => SWALLOWED_BUILD_FAILURES.some(pattern => pattern.test(line)));
    if (at >= 0) return lines.slice(at, at + 20).join('\n').trim();
  }
  return null;
}
