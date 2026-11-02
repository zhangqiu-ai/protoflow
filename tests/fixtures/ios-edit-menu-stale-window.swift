// Foundation-only protocol model. No UIKit, Simulator, App fixture or production input.
import Foundation
import CoreGraphics
class XCUIElement {
 enum ElementType {case textField,textView,searchField,secureTextField,menuItem,button,other}
 var elementType:ElementType = .other,label="",frame=CGRect.zero,exists=true,isEnabled=true,isHittable=true
 var stored="synthetic-original",placeholderValue="",reads=0,deletes=0,presses=0
 var value:Any?{reads += 1;return stored}
 var action:(()->Void)?,deleteAction:(()->Void)?
 init(_ type:ElementType = .other,_ label:String="",_ frame:CGRect = .zero){elementType=type;self.label=label;self.frame=frame}
 func tap(){action?()};func press(forDuration:Double){presses += 1};func waitForExistence(timeout:Double)->Bool{exists}
 func typeText(_ t:String){if t==XCUIKeyboardKey.delete.rawValue{deletes += 1;deleteAction?()}else{stored += t}}
}
enum XCUIKeyboardKey:String{case delete="<DELETE>"}
class XCUIElementSnapshot {
 let elementType:XCUIElement.ElementType,label:String,frame:CGRect,children:[XCUIElementSnapshot]
 init(_ t:XCUIElement.ElementType = .other,_ label:String="",_ f:CGRect = .zero,_ c:[XCUIElementSnapshot]=[]){elementType=t;self.label=label;frame=f;children=c}
}
class Query {
 let elements:[XCUIElement];init(_ e:[XCUIElement]){elements=e}
 var allElementsBoundByIndex:[XCUIElement]{elements}
 var firstMatch:XCUIElement{if let e=elements.first{return e};let e=XCUIElement();e.exists=false;return e}
 subscript(label:String)->Query{Query(elements.filter{$0.label==label})}
 func matching(_ p:NSPredicate)->Query{Query(elements.filter{p.evaluate(with:["label":$0.label])})}
}
class XCUIApplication {
 let mode:String;var forwards=0,afterForwardSnapshots=0,snapshotObservedGeneration=0,cacheFresh=false
 var field=XCUIElement(.textView)
 init(_ m:String){mode=m;field.deleteAction={ [weak self] in if m != "partial-delete"{self?.field.stored=""}}}
 var expanded:Bool{forwards>0}
 func item(_ label:String,_ type:XCUIElement.ElementType = .menuItem)->XCUIElement{XCUIElement(type,label,CGRect(x:26,y:207,width:129,height:69))}
 var menuItems:Query {
  if mode=="no-actions"{return Query([])}
  if mode=="immediate-menu" || mode=="partial-delete"{return Query([item("Select All")])}
  if mode=="budget"{return Query([item(["one","two","three","four"][min(forwards,3)])])}
  if expanded && (cacheFresh || mode=="fresh-window"){return Query([])}
  return Query([item("Select")])
 }
 var buttons:Query {
  if expanded && (cacheFresh || mode=="fresh-window"){return Query([item("Select All",.button)])}
  func forward()->XCUIElement{let e=XCUIElement(.button,"Forward",CGRect(x:153,y:211,width:61,height:61));e.action={ [weak self] in self?.forwards += 1;self?.cacheFresh=false };if mode=="hidden-forward"{e.isHittable=false};return e}
  return Query(mode=="ambiguous-forward" ? [forward(),forward()]:[forward()])
 }
 func snapshot()throws->XCUIElementSnapshot {
  if expanded && snapshotObservedGeneration<forwards {
   snapshotObservedGeneration=forwards;afterForwardSnapshots += 1
   if mode=="snapshot-throw"{throw NSError(domain:"SyntheticSnapshotFailure",code:1)}
   if mode=="stale-window"{cacheFresh=true}
  }
  let children=(menuItems.elements+buttons.elements).map{XCUIElementSnapshot($0.elementType,$0.label,$0.frame)}
  if mode=="foreign-forward"{return XCUIElementSnapshot(.other,"",CGRect(x:0,y:0,width:375,height:667),children)}
  return XCUIElementSnapshot(.other,"",CGRect(x:0,y:0,width:375,height:667),[XCUIElementSnapshot(.other,"",CGRect(x:26,y:207,width:188,height:69),children)])
 }
}
class Subject {
    // A probe capture: clearField goes straight to the public replacement path.
    var publicReplacementOnly = true
    // ACTUAL_SDK_PUBLIC_INPUT_HELPERS
    func exercise(_ field: XCUIElement, app: XCUIApplication) -> String? { clearPublicly(field, app: app) }

}
var results:[[String:Any]]=[]
for mode in ["stale-window","fresh-window","immediate-menu","snapshot-throw","no-actions","ambiguous-forward","foreign-forward","hidden-forward","invalid-input","partial-delete","budget","secure","unreachable","stuck-window"] {
 let app=XCUIApplication(mode),s=Subject()
 if mode=="secure"{app.field.elementType = .secureTextField}
 if mode=="invalid-input"{app.field.elementType = .button}
 if mode=="unreachable"{app.field.isHittable=false}
 let error=s.exercise(app.field,app:app)
 let success=["stale-window","fresh-window","immediate-menu"].contains(mode)
 var pass=(error==nil)==success
 if mode=="stale-window"{pass = pass && app.forwards==1 && app.afterForwardSnapshots==1 && app.field.deletes==1}
 if mode=="fresh-window"{pass = pass && app.forwards==1 && app.field.deletes==1}
 if mode=="immediate-menu"{pass = pass && app.forwards==0 && app.afterForwardSnapshots==0 && app.field.deletes==1}
 if mode=="snapshot-throw"{pass = pass && error=="public edit menu refresh snapshot is unavailable" && app.field.deletes==0}
 if mode=="no-actions" || mode=="ambiguous-forward" || mode=="foreign-forward" || mode=="hidden-forward"{pass = pass && app.forwards==0 && app.field.deletes==0}
 if mode=="secure" || mode=="invalid-input"{pass = pass && app.field.reads==0 && app.field.presses==0}
 if mode=="unreachable"{pass = pass && app.field.presses==0}
 if mode=="partial-delete"{pass = pass && error=="public Select All did not clear the complete input" && app.field.deletes==1}
 if mode=="budget"{pass = pass && app.forwards==3 && app.field.deletes==0}
 if mode=="stuck-window"{pass = pass && error=="public edit menu did not advance" && app.forwards==1 && app.field.deletes==0}
 results.append(["mode":mode,"pass":pass,"reason":error as Any? ?? NSNull(),"forwards":app.forwards,"afterForwardSnapshots":app.afterForwardSnapshots,"deletes":app.field.deletes,"valueReads":app.field.reads])
}
print(String(data:try JSONSerialization.data(withJSONObject:["kind":"ACTUAL_SWIFT_STALE_WINDOW_QUERY_MODEL_NOT_UIKIT_OR_CAUSAL_EVIDENCE","results":results],options:[.sortedKeys]),encoding:.utf8)!)
exit(results.allSatisfy{($0["pass"] as? Bool)==true} ? 0:1)
