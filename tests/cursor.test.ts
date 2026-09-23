import test from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../src/server/surface.js';
import {trackCursor,moveToControl} from '../src/server/cursor.js';
test('cursor tracks real intermediate movement and clicks without a DOM overlay; ownership loss stops motion',async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:800,height:600}});const state=await trackCursor(page);
  await page.goto('data:text/html,<button style="position:absolute;left:400px;top:300px;width:100px;height:40px">Target</button>');
  const target=page.getByRole('button',{name:'Target'});const points:number[]=[];
  await moveToControl(page,target,state,()=>{points.push(state.x);});
  await target.click();await page.waitForTimeout(50);
  assert.ok(points.some(x=>x>0&&x<450));assert.equal(Math.round(state.x),450);assert.equal(Math.round(state.y),320);assert.equal(state.clickSequence,1);assert.equal(state.pressed,false);
  assert.equal(await page.locator('body > *').count(),1);
  const before=state.clickSequence;await page.evaluate(()=>document.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:12,clientY:12})));
  await page.waitForTimeout(30);assert.equal(state.clickSequence,before);
  let checks=0;await assert.rejects(moveToControl(page,target,state,()=>{if(++checks===4)throw new Error('ownership changed');}),/ownership changed/);
  await page.goto('data:text/html,Another page');assert.equal(state.visible,false);
 }finally{await browser.close();}
});
