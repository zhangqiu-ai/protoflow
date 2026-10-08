import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { projectPath, runCommand } from '../util.js';
import { driverResponseSchema } from '../protocol-schemas.js';

const validateResponse = new Ajv({ allErrors: true, strict: false }).compile(driverResponseSchema);

/*
 * External driver protocol (schemas/driver-request.schema.json, schemas/driver-response.schema.json): one argv
 * process per capture, request on stdin, response on stdout. The driver owns launching the app, reaching the state
 * and locating anchors by the platform's identifiers. The engine only trusts the returned facts and screenshot.
 */

const elementFields = ['count', 'visible', 'enabled', 'interactive', 'editable', 'bounds', 'text', 'index', 'inputType', 'role', 'style'];

function normalizeResponse(response) {
  if (!response || response.schemaVersion !== 1 || !['PASS', 'FAIL', 'NOT_RUN'].includes(response.status)) throw new Error('Driver response must have schemaVersion 1 and status PASS|FAIL|NOT_RUN');
  if (!validateResponse(response)) throw new Error(`Driver response does not match schemas/driver-response.schema.json: ${JSON.stringify(validateResponse.errors)}`);
  const elements = {};
  for (const item of response.elements ?? []) {
    if (typeof item?.anchor !== 'string') throw new Error('Driver element without anchor');
    elements[item.anchor] = Object.fromEntries(elementFields.filter(field => field in item).map(field => [field, item[field]]));
    elements[item.anchor].count ??= 1;
    // Native platforms rarely expose a document index; the tiers then fall back to reading order.
  }
  for (const id of response.missing ?? []) elements[id] = { count: 0, visible: false };
  return { ...response, elements };
}

/**
 * Run one capture. Returns { status, reason?, capture? }: PASS with a capture, FAIL when the application could not
 * reach the state (the driver says so), NOT_RUN when the driver or its device is unavailable.
 */
export async function captureExternal(root, target, request, hooks = {}) {
  const command = target.driver?.command;
  if (!command) return { status: 'NOT_RUN', reason: `target ${target.id} has no driver command` };
  const outputDir = await projectPath(root, request.outputDir);
  await mkdir(outputDir, { recursive: true });
  const run = await runCommand(root, command, request, hooks);
  if (run.processGroupActive) {
    const error = new Error(`Driver subprocess group for ${target.id} remains active; stop it before further verification`);
    error.code = 'PROCESS_GROUP_ACTIVE'; error.phase = 'visual-driver'; error.result = run;
    throw error;
  }
  if (run.status !== 'PASS') return { status: 'NOT_RUN', reason: `driver ${target.id} failed (${run.error ?? `exit ${run.exitCode}`}): ${(run.stderr || '').trim().slice(-500)}` };
  let response;
  try { response = normalizeResponse(JSON.parse(run.stdout)); }
  catch (error) { return { status: 'NOT_RUN', reason: `driver ${target.id} returned an invalid response: ${error.message}` }; }
  if (response.status !== 'PASS') return { status: response.status, reason: response.reason ?? `driver reported ${response.status}` };
  let screenshot = null;
  if (response.screenshot) {
    const file = path.resolve(outputDir, response.screenshot);
    if (path.relative(outputDir, file).startsWith('..')) return { status: 'NOT_RUN', reason: 'driver screenshot path escapes its output directory' };
    screenshot = await readFile(file);
  }
  return { status: 'PASS', capture: { viewport: response.viewport ?? request.viewport, screenshot, elements: response.elements } };
}
