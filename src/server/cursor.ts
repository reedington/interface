import type { Page, Locator } from 'playwright-core';
import { randomUUID } from 'node:crypto';

export interface CursorState { x:number;y:number;visible:boolean;pressed:boolean;clickSequence:number;updatedAt:number; }
/** Observes real trusted Chromium mouse events; does not inject a DOM cursor. */
export async function trackCursor(page:Page):Promise<CursorState>{
 const state:CursorState={x:0,y:0,visible:false,pressed:false,clickSequence:0,updatedAt:0};
 const binding=`__interfacePointer_${randomUUID().replaceAll('-','')}`;
 await page.exposeBinding(binding,({frame},event:{x:number;y:number;type:string})=>{
  if(frame!==page.mainFrame()||!Number.isFinite(event.x)||!Number.isFinite(event.y))return;
  const viewport=page.viewportSize();if(!viewport||event.x<0||event.y<0||event.x>viewport.width||event.y>viewport.height)return;
  state.x=event.x;state.y=event.y;state.visible=true;state.updatedAt=Date.now();
  if(event.type==='mousedown'){state.pressed=true;state.clickSequence++;}
  if(event.type==='mouseup')state.pressed=false;
 });
 page.on('framenavigated',frame=>{if(frame===page.mainFrame()){state.visible=false;state.pressed=false;}});
 await page.addInitScript((name)=>{
  for(const type of ['mousemove','mousedown','mouseup'])document.addEventListener(type,event=>{
   const mouse=event as MouseEvent;if(!mouse.isTrusted)return;
   void (window as unknown as Record<string,(data:unknown)=>Promise<void>>)[name]({x:mouse.clientX,y:mouse.clientY,type}).catch(()=>{});
  },{capture:true,passive:true});
 },binding);
 return state;
}
/** Move the actual browser pointer, retaining locator-based actionability for the subsequent action. */
export async function moveToControl(page:Page,locator:Locator,cursor:CursorState|undefined,assertOwner:()=>void){
 assertOwner();await locator.scrollIntoViewIfNeeded();assertOwner();
 const box=await locator.boundingBox();if(!box)throw new Error('The pointer target is no longer visible.');
 const x=box.x+box.width/2,y=box.y+box.height/2;
 const start={x:cursor?.x||0,y:cursor?.y||0};
 for(let step=1;step<=8;step++){
  assertOwner();await page.mouse.move(start.x+(x-start.x)*step/8,start.y+(y-start.y)*step/8);
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 assertOwner();
}
