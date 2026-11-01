import { test,expect } from 'playwright/test';
import { driverOptions,responsiveOptionsError } from '../../scripts/ios-driver.js';
// Public driver option contract only; no browser, simulator, provider or Native process is launched.
test('bounded host settling option parses and rejects unsupported values before device work',()=>{
 const request={screen:'test.screen',state:'ready',steps:[]};
 for(const value of ['6000','8000','10000']){const values=driverOptions(['--uikit-probe-context','CTX-synthetic','--uikit-settling-budget-ms',value]);expect(values['uikit-settling-budget-ms']).toBe(value);expect(responsiveOptionsError(values,request)).toBeNull();}
 for(const value of ['0','5999','10001','Infinity','NaN','6e3','6000.5','-6000','', ' 6000']){expect(responsiveOptionsError({'uikit-probe-context':'CTX-synthetic','uikit-settling-budget-ms':value},request)).toMatch(/settling-budget/);}
 expect(responsiveOptionsError({'uikit-settling-budget-ms':'10000'},request)).toMatch(/uikit-probe-context/);
 expect(responsiveOptionsError(driverOptions([]),request)).toBeNull();expect(driverOptions([])['uikit-settling-budget-ms']).toBeUndefined();
});
