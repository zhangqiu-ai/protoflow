import {controlFixture} from './uikit-probe-control-fixtures.js';
const plain=()=>({userInteractionEnabled:true,effectiveUserInteractionEnabled:true,buttonTrait:false,linkTrait:false,sources:{userInteractionEnabled:'UIView.userInteractionEnabled',effectiveUserInteractionEnabled:'currentUIKitAncestorInteraction',buttonTrait:'UIAccessibilityTraitsButton',linkTrait:'UIAccessibilityTraitsLink'}});
export function progressFixture(change=()=>{}){
 return controlFixture(f=>{
  const {uikit,ax,rect}=f,bodyFrame=rect(40,100,320,240),imageFrame=rect(40,140,300,180),spinnerFrame=rect(50,150,20,20),introFrame=rect(40,100,320,24),statusFrame=rect(80,150,220,20),detailFrame=rect(50,190,270,40);
  const make=(id,text='',children=[],frame=rect(),extra={})=>uikit(id,text,children,frame,{observedSemantics:plain(),...extra});
  const spinner=make('','',[make('','',[],spinnerFrame,{class:'ArbitraryImageView'})],spinnerFrame,{class:'ArbitraryObservedView',accessibilityLabel:'Accessible busy state'});
  const wrapper=make('','',[spinner],spinnerFrame);
  const image=make('test.image','',[wrapper,make('test.status','Creating example…',[],statusFrame),make('','Example detail',[],detailFrame)],imageFrame);
  const body=make('test.body','',[make('','Example reply',[],introFrame),image],bodyFrame);
  Object.assign(f.tree,make('test.screen','',[body]));
  const axSpinner=ax('','other','Accessible busy state',[],spinnerFrame);axSpinner.observedNonTextKind={kind:'activityIndicator',source:'XCUIElementSnapshot.elementType'};
  const axWrapper=ax('','other','',[axSpinner],spinnerFrame);
  const axImage=ax('test.image','other','',[axWrapper,ax('test.status','staticText','Creating example…',[],statusFrame),ax('','staticText','Example detail',[],detailFrame)],imageFrame);
  const axBody=ax('test.body','other','',[ax('','staticText','Example reply',[],introFrame),axImage],bodyFrame);
  Object.assign(f.rawAX,ax('test.screen','other','',[axBody]));f.anchors.splice(0,f.anchors.length,'test.screen','test.body','test.image','test.status');
  const actualBody=f.tree.children[0],actualImage=actualBody.children[1],actualWrapper=actualImage.children[0],actualSpinner=actualWrapper.children[0];
  Object.assign(f,{body:actualBody,image:actualImage,spinner:actualSpinner,wrapper:actualWrapper,axBody,axImage,axSpinner,axWrapper,make});change(f);
 });
}
export const bodyText=f=>f.result.elements.find(e=>e.anchor==='test.body').text;
export const physicalExpected='Example reply Creating example… Example detail';
export const rejectionCases=[
 ['missing typed evidence',f=>delete f.axSpinner.observedNonTextKind],
 ['wrong typed source',f=>f.axSpinner.observedNonTextKind.source='untrusted'],
 ['extra untrusted proof fields',f=>f.axSpinner.observedNonTextKind.extra=true],
 ['current action role',f=>{f.spinner.observedSemantics.buttonTrait=true;}],
 ['duplicate owner identity',f=>f.tree.children.push({...structuredClone(f.body),children:[]})],
 ['ambiguous same-frame parent chain',f=>{f.wrapper.children=[f.make('','',[f.spinner],f.spinner.frameInScreen)];}],
 ['long unmatched anonymous chain',f=>{let a=f.axSpinner,c=f.spinner;for(let i=0;i<20;i++)a=f.ax('','other','',[a],i===19?{...f.axSpinner.frame,width:21}:f.axSpinner.frame);for(let i=0;i<39;i++)c=f.make('','',[c],f.spinner.frameInScreen);f.axImage.children[0]=a;f.image.children[0]=c;}],
 ['wrong typed category',f=>f.axSpinner.observedNonTextKind.kind='customDrawnView'],
 ['wrong original role',f=>f.axSpinner.type='button'],
 ['current missing typed semantics',f=>delete f.spinner.observedSemantics],
 ['input descendant',f=>{Object.assign(f.spinner,{inputRedacted:true,textSource:'redactedInput',accessibilityLabelRedacted:true});delete f.spinner.children;delete f.spinner.accessibilityLabel;Object.assign(f.spinner.observedSemantics,{inputKind:'textField',editable:true});Object.assign(f.spinner.observedSemantics.sources,{inputKind:'UIKit.publicType',editable:'UITextField.enabled'});}],
 ['foreign nearest identified parent',f=>{f.wrapper.children=[];f.image.children.push(f.make('test.foreign','',[f.spinner],f.spinner.frameInScreen));}],
 ['wrong spinner frame',f=>{f.spinner.frameInScreen={...f.spinner.frameInScreen,x:51};f.spinner.frameInWindow=f.spinner.frameInScreen;}],
 ['duplicate same-frame label contributor',f=>f.wrapper.children.push(structuredClone(f.spinner))],
 ['duplicate same-frame physical text',f=>f.body.children.push(structuredClone(f.body.children[0]))],
 ['unknown anonymous contributor',f=>f.axImage.children.push(f.ax('','other','Unproven custom canvas',[],f.rect(270,250,20,20)))],
 ['transformed contributor',f=>f.spinner.transformed=true],
 ['hidden contributor',f=>{f.spinner.hidden=true;for(const n of [f.spinner,...f.spinner.children]){n.ancestorOrSelfHidden=true;n.renderEligible=false;}}],
];
