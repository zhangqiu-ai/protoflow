/*
 * Deep-link launch for the native reference drivers (`--launch-url TEMPLATE`). Apps whose screens are routes, such as
 * Expo Router, open a scene from a URL instead of reading launch arguments or intent extras:
 *
 *   --launch-url "myapp://{screen}?state={state}&fixture={fixture}"
 *
 * `{screen}` and `{state}` are the request's values, `{fixture}` the fixture data as JSON; each is percent-encoded.
 * Pure, so the substitution rules are testable without a simulator or emulator.
 */

const PLACEHOLDER = /\{(screen|state|fixture)\}/g;

/** A template problem, or null; checked before any device is touched. */
export function launchUrlTemplateError(template) {
  if (!template.includes('{screen}')) return `--launch-url must contain {screen} so each scene opens its own screen: ${template}`;
  const unknown = template.replace(PLACEHOLDER, '').match(/\{[^}]*\}/);
  if (unknown) return `--launch-url has an unknown placeholder ${unknown[0]}; use {screen}, {state} or {fixture}`;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(template)) return `--launch-url needs a URL scheme, e.g. myapp://{screen}: ${template}`;
  return null;
}

/** The URL that opens `request.screen` in `request.state` with its fixture. */
export function launchUrl(template, request) {
  const values = { screen: request.screen, state: request.state ?? '', fixture: JSON.stringify(request.fixture?.data ?? {}) };
  return template.replace(PLACEHOLDER, (_, name) => encodeURIComponent(values[name]));
}
