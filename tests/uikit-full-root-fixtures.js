import { controlFixture } from './uikit-probe-control-fixtures.js';
const neutral = () => ({ userInteractionEnabled: true, effectiveUserInteractionEnabled: true, buttonTrait: false, linkTrait: false, sources: { userInteractionEnabled: 'UIView.userInteractionEnabled', effectiveUserInteractionEnabled: 'currentUIKitAncestorInteraction', buttonTrait: 'UIAccessibilityTraitsButton', linkTrait: 'UIAccessibilityTraitsLink' } });
export function fullRootFixture(kind = 'icon', change = () => {}) {
  return controlFixture(f => {
    const { tree, rawAX, control, axControl, uikit, ax, rect } = f;
    Object.assign(tree, { observedSemantics: neutral() });
    if (kind === 'ring') {
      const goalFrame=rect(16,86,370,74), ringFrame=rect(30,100,46,46), digitFrame=rect(44,116,18,14), titleFrame=rect(90,100,250,22), detailFrame=rect(90,126,250,18);
      tree.children=[uikit('test.goal','',[uikit('test.progress','',[uikit('test.number','29',[],digitFrame)],ringFrame),uikit('', '', [uikit('test.goal.title','Goal heading',[],titleFrame),uikit('test.goal.detail','7 sessions',[],detailFrame)],rect(90,100,250,44))],goalFrame,{observedSemantics:structuredClone(control.observedSemantics)})];
      rawAX.children=[ax('test.goal','button','Goal accessibility summary',[],goalFrame)];
      f.anchors.splice(1,f.anchors.length-1,'test.goal');
    } else if (kind === 'footer') {
      const head=rect(20,50,300,24), tail=rect(20,900,300,24), viewport=rect(0,32,400,700), bar=rect(0,730,400,60);
      tree.children=[uikit('test.body','',[uikit('test.heading','Body heading',[],head),uikit('test.tail','Body tail',[],tail,{renderEligible:false,clipIntersection:rect(0,0,0,0)})],viewport,{class:'UIScrollView',clipsToBounds:true,scrollGeometry:{source:'UIScrollView.publicGeometry',isScrollView:true,scrollEnabled:true,contentOffset:{x:0,y:0},contentSize:{width:400,height:1000},contentInset:{top:0,left:0,bottom:0,right:0}}}),uikit('test.tabs','',[uikit('test.tab','Footer caption',[],rect(20,750,150,20))],bar)];
      rawAX.children=[ax('test.heading','staticText','Body heading',[],head),ax('test.tabs','other','',[ax('test.tab','button','Footer caption',[],rect(20,750,150,20))],bar),ax('test.tail','staticText','Body tail',[],tail)];
      f.anchors.splice(1,f.anchors.length-1,'test.heading','test.tabs','test.tab','test.tail');
    } else if (kind === 'icon') {
      control.identifier=''; axControl.identifier=''; f.anchors.splice(f.anchors.indexOf('test.action'),1);
    } else if (kind === 'caption') {
      control.children=[uikit('test.caption','Actual caption',[],rect(20,100,120,24))];
    } else if (kind === 'input') {
      const inputFrame=rect(20,150,240,30), input=uikit('test.input','',[],inputFrame,{inputRedacted:true,textSource:'redactedInput',observedSemantics:{...neutral(),inputKind:'textField',editable:true,sources:{...neutral().sources,inputKind:'UIKit.publicType',editable:'UITextField.enabled'}}});
      delete input.children;tree.children.push(input);rawAX.children.push(ax('test.input','textField','Accessible field',[],inputFrame));f.input=input;f.inputAX=rawAX.children.at(-1);
    }
    const screenUIKit={...tree}, screenAX={...rawAX};
    Object.assign(tree,{identifier:'',class:'UIWindow',observedSemantics:neutral(),children:[screenUIKit]});
    Object.assign(rawAX,{identifier:'',type:'application',children:[ax('','window','',[screenAX],rect())]});
    f.screenAX=screenAX;f.screenUIKit=screenUIKit;f.content=rect();f.windowFrame=rect();
    change(f);
  });
}
export const screen = fixture => fixture.result.elements.find(item => item.anchor === 'test.screen');
