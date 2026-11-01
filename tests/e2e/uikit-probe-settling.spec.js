import { test,expect } from 'playwright/test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec=promisify(execFile),root=new URL('../../',import.meta.url);
test('actual Swift capture fragment runs readiness after preparation and before the untouched measured pair',async({},info)=>{
 const source=await readFile(new URL('drivers/ios/UITests/CaptureTests.swift',root),'utf8');
 const fragment=source.slice(source.indexOf('        Thread.sleep(forTimeInterval: 0.3)'),source.indexOf('        // A state that ends while typing'));
 const probeDeclaration=source.slice(source.indexOf('    struct CaptureProbe: Decodable'),source.indexOf('    struct Job: Decodable'));
 const observation=source.match(/            if let accessibilityPreparation \{ result\["accessibilityPreparation"\] = accessibilityPreparation \}/)[0];
 const shim=`import Foundation
var events: [String] = []
let mode=CommandLine.arguments[1]
${probeDeclaration}
typealias Probe=CaptureProbe
func makeProbe(_ enabled:Bool?)->Probe {var fields:[String:Any]=["nonce":"synthetic","contextId":"CTX-synthetic","sceneId":"test.screen","screenAnchor":"test.screen","outputDir":"synthetic"];if let enabled {fields["settleBeforeCapture"]=enabled};return try! JSONDecoder().decode(Probe.self,from:JSONSerialization.data(withJSONObject:fields))}
struct Job {let captureProbe: Probe?;let hittableAnchors:[String]? = nil}
struct Target {let exists=false;let isEnabled=false;let isHittable=false}
struct Keyboards {var firstMatch:Target{Target()}}
final class App {var calls=0;var keyboards:Keyboards{Keyboards()};func snapshot() throws -> Int {calls+=1;events.append("snapshot");if mode == "preparation-error" && calls == 1 {throw NSError(domain:"preparation",code:1)};return calls}}
struct Shot {var pngRepresentation:Data{Data()}}
struct XCUIScreen {static var main:XCUIScreen{XCUIScreen()};func screenshot()->Shot{events.append("screenshot");return Shot()}}
func element(_ app:App,_ anchor:String)->Target{Target()}
func serialize(_ value:Int)->[String:Any]{["ordinal":value]}
func failure(_ app:App,_ output:URL,_ reason:String)->[String:Any]{["status":"NOT_RUN","reason":reason]}
func requestProbe(_ probe:Probe,phase:String)->String? {events.append(phase);return mode == "settling-error" && phase == "settle" ? "bounded settling did not become quiet" : nil}
let app=App();let output=URL(fileURLWithPath:CommandLine.arguments[2])
func capture() throws {let job=Job(captureProbe:mode == "default" ? nil : makeProbe(mode == "legacy" ? nil : true));var result:[String:Any]=[:];let responsive:[String:Any]?=nil;var accessibilityPreparation:[String:Any]?=nil
 defer {
${observation}
try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]).write(to:output.appendingPathComponent("raw.json"))
 }
${fragment}
}
var thrown=false;do{try capture()}catch{thrown=true}
print(String(data:try JSONSerialization.data(withJSONObject:["events":events,"thrown":thrown],options:[.sortedKeys]),encoding:.utf8)!)
`;
 const file=info.outputPath('actual-fragment.swift'),binary=info.outputPath('fragment');await writeFile(file,shim);
 const compile=await exec('xcrun',['--sdk','macosx','swiftc',file,'-o',binary],{timeout:60000});await writeFile(info.outputPath('compile.log'),compile.stdout+compile.stderr);
 const results=[];
 for(const mode of ['default','legacy','opted','settling-error','preparation-error']){const directory=info.outputPath(mode);await mkdir(directory);const run=await exec(binary,[mode,directory]);const actual=JSON.parse(run.stdout),raw=JSON.parse(await readFile(path.join(directory,'raw.json'),'utf8'));results.push({mode,actual,raw});
  if(mode==='default'){expect(actual.events).toEqual(['snapshot','screenshot']);expect(raw.probeTiming).toBeUndefined();}
  if(mode==='legacy')expect(actual.events).toEqual(['snapshot','before','snapshot','screenshot','after']);
  if(mode==='opted'){expect(actual.events).toEqual(['snapshot','settle','before','snapshot','screenshot','after']);expect(raw.probeTiming.axStartedAt).toBeGreaterThanOrEqual(raw.accessibilityPreparation.finishedAt);expect(raw.status).toBe('PASS');}
  if(mode==='settling-error'){expect(actual.events).toEqual(['snapshot','settle']);expect(raw.status).toBe('NOT_RUN');expect(raw.probeTiming).toBeUndefined();}
  if(mode==='preparation-error'){expect(actual.events).toEqual(['snapshot']);expect(actual.thrown).toBe(true);}
 }
 await writeFile(info.outputPath('observed-sequence.json'),JSON.stringify({kind:'Foundation-shim scheduling only; not XCTest/UIKit/Native acceptance',results},null,2));
});
