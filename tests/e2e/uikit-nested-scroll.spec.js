import { test } from '@playwright/test';
import { interpretUIKitCapture } from '../../src/drivers/uikit-probe-text.js';
import { scenarios, verifyScenario } from '../uikit-nested-scroll-fixtures.js';
for (const scenario of scenarios) test(scenario.name, () => verifyScenario(interpretUIKitCapture, scenario));
