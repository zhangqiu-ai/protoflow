import { ANCHOR_ID, ROLES, ACTIONS, sidecarSchema } from './anchors.js';

/* Published contracts for docs/proposals/0001-anchor-contracts.md; scripts/check.js keeps schemas/ in sync. */

const anchorId = { type: 'string', pattern: ANCHOR_ID.source };
const box = { type: 'object', required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } } };
const viewport = { type: 'object', required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, scale: { type: 'number', minimum: 0.5, maximum: 4 } } };
const step = { type: 'object', required: ['action'], properties: { action: { enum: ACTIONS }, anchor: anchorId, value: { type: 'string' }, timeoutMs: { type: 'integer' } } };

export { sidecarSchema };

export const staticContractSchema = {
  type: 'object', required: ['schemaVersion', 'extractorVersion', 'screens', 'pages', 'errors', 'warnings'],
  properties: {
    schemaVersion: { const: 1 }, extractorVersion: { type: 'string' },
    screens: { type: 'object', propertyNames: { pattern: ANCHOR_ID.source }, additionalProperties: {
      type: 'object', required: ['page', 'anchors', 'states', 'resources'],
      properties: {
        page: { type: 'string' }, sidecar: { type: ['string', 'null'] },
        anchors: { type: 'array', items: { type: 'object', required: ['id', 'role', 'parent', 'order'], properties: {
          id: anchorId, role: { enum: ROLES }, parent: { anyOf: [anchorId, { type: 'null' }] }, order: { type: 'integer', minimum: 0 },
          repeat: { type: 'boolean' }, dynamic: { type: 'boolean' }, visualOnly: { type: 'boolean' },
          tag: { type: 'string' }, inputType: { type: ['string', 'null'] }, text: { type: ['string', 'null'] }
        } } },
        states: { type: 'object', additionalProperties: { type: 'object', required: ['steps', 'expect'], properties: {
          fixture: { type: ['string', 'null'] }, steps: { type: 'array', items: step },
          expect: { type: 'object', properties: { visible: { type: 'array', items: anchorId }, hidden: { type: 'array', items: anchorId } } }
        } } },
        fixtures: { type: 'object' }, resources: { type: 'array', items: { type: 'string' } }
      }
    } },
    pages: { type: 'object', additionalProperties: anchorId },
    errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }
  }
};

export const driverRequestSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'target', 'screen', 'state', 'page', 'fixture', 'steps', 'anchors', 'viewport', 'outputDir'],
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'capture' },
    target: { type: 'object', required: ['id', 'platform', 'root'], properties: { id: { type: 'string' }, platform: { type: 'string' }, root: { type: 'string' } } },
    screen: anchorId, state: { type: 'string' }, page: { type: 'string' },
    fixture: { type: 'object', required: ['data'], properties: { name: { type: ['string', 'null'] }, data: { type: 'object' } } },
    steps: { type: 'array', items: step }, anchors: { type: 'array', items: anchorId },
    viewport, outputDir: { type: 'string' }
  }
};

export const driverResponseSchema = {
  type: 'object', required: ['schemaVersion', 'status'],
  properties: {
    schemaVersion: { const: 1 }, status: { enum: ['PASS', 'FAIL', 'NOT_RUN'] }, reason: { type: 'string' },
    screenshot: { type: 'string', minLength: 1 }, viewport, log: { type: 'string' },
    elements: { type: 'array', items: { type: 'object', required: ['anchor'], properties: {
      anchor: anchorId, count: { type: 'integer', minimum: 0 }, visible: { type: 'boolean' }, enabled: { type: 'boolean' },
      interactive: { type: 'boolean' }, editable: { type: 'boolean' }, bounds: box, text: { type: 'string' },
      index: { type: 'integer' }, inputType: { type: ['string', 'null'] }, role: { type: 'string' },
      style: { type: 'object', properties: { color: { type: 'string' }, backgroundColor: { type: 'string' }, fontSize: { type: ['string', 'number'] }, fontWeight: { type: ['string', 'number'] }, borderRadius: { type: ['string', 'number'] } } }
    } } },
    missing: { type: 'array', items: anchorId }
  }
};
