import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
const extract=(source,start)=>{const from=source.indexOf(start);assert.ok(from>=0);let depth=0,end=source.indexOf('{',from);const opening=end;for(;end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}'&&!--depth)break;}assert.ok(end>opening);return source.slice(from,end+1)};
test('actual serialize source adds typed activity metadata while legacy type, label, frame and child tree remain intact (Foundation protocol only)',{skip:process.platform!=='darwin'&&'Swift helper runtime needs the macOS Swift toolchain'},async()=>{
 const file=process.env.PROGRESS_SWIFT_SOURCE??new URL('../drivers/ios/UITests/CaptureTests.swift',import.meta.url).pathname;
 const source=await readFile(file,'utf8'),type=extract(source,'private func typeName('),serialize=extract(source,'private func serialize(');
 const cases=[...new Set([...type.matchAll(/case \.(\w+):/g)].map(m=>m[1]).concat(['activityIndicator','other']))].map(c=>'`'+c+'`').join(',');
 const code=`import Foundation
struct ProtocolPoint { let x:Double;let y:Double };struct ProtocolSize { let width:Double;let height:Double };struct ProtocolFrame { let origin:ProtocolPoint;let size:ProtocolSize }
class XCUIElement { enum ElementType { case ${cases} } }
final class XCUIElementSnapshot {
 let elementType:XCUIElement.ElementType;let identifier="";let label:String;let isEnabled=true;let isSelected=false
 let frame=ProtocolFrame(origin:ProtocolPoint(x:1,y:2),size:ProtocolSize(width:20,height:20));let value:String?=nil;let placeholderValue:String?=nil;let children:[XCUIElementSnapshot]
 init(_ kind:XCUIElement.ElementType,_ label:String,_ children:[XCUIElementSnapshot]=[]){self.elementType=kind;self.label=label;self.children=children}
}
final class Harness {
 ${type}
 ${serialize}
 func run(_ node:XCUIElementSnapshot)->[String:Any]{return serialize(node)}
}
let h=Harness();let sample=XCUIElementSnapshot(.other,"parent",[XCUIElementSnapshot(.activityIndicator,"Busy label"),XCUIElementSnapshot(.other,"Custom label"),XCUIElementSnapshot(.staticText,"Real caption")])
let bytes=try JSONSerialization.data(withJSONObject:h.run(sample),options:[.sortedKeys]);print(String(data:bytes,encoding:.utf8)!)
`;
 const dir=await mkdtemp(path.join(tmpdir(),'protoflow-progress-swift-protocol-')),swift=path.join(dir,'main.swift');await writeFile(swift,code,{mode:0o600});
 const output=JSON.parse(execFileSync('swift',[swift],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
 assert.equal(output.type,'other');assert.equal(output.children.length,3);
 const[activity,custom,text]=output.children;assert.equal(activity.type,'other');assert.equal(activity.label,'Busy label');assert.deepEqual(activity.frame,{x:1,y:2,width:20,height:20});
 assert.deepEqual(activity.observedNonTextKind,{kind:'activityIndicator',source:'XCUIElementSnapshot.elementType'});assert.ok(!('observedNonTextKind'in custom));assert.ok(!('observedNonTextKind'in text));assert.equal(text.type,'staticText');assert.equal(text.label,'Real caption');
});
