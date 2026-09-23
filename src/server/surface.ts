import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page, type Locator } from 'playwright-core';
import type { TargetLocator, RunInputs, Observation, ObservedControl } from '../shared/contracts.js';

export function browserPath():string|undefined {
  return [process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium',process.env.LOCALAPPDATA?`${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`:undefined].find(p=>p&&existsSync(p));
}
export async function launchBrowser():Promise<Browser> {
  const executablePath=browserPath();
  if(!executablePath) throw new Error('Install Google Chrome or set CHROME_PATH to a Chromium executable.');
  return chromium.launch({executablePath,headless:true,chromiumSandbox:true,args:['--disable-background-networking']});
}
export function interpolate(value:string,inputs:RunInputs):string {
  return value.replace(/\{\{(clientReference|accountReference|product|externalReference|firstName|lastName|memberActivationDate)\}\}/g,(_,key:keyof RunInputs)=>inputs[key]??'');
}
export function locate(page:Page,target:TargetLocator,inputs:RunInputs):Locator {
  const value=interpolate(target.value,inputs);
  const root=target.scope?page.locator(interpolate(target.scope,inputs)):page;
  if(target.kind==='label') return root.getByLabel(value,{exact:target.exact});
  if(target.kind==='role') return root.getByRole(target.role as Parameters<Page['getByRole']>[0],{name:value,exact:target.exact});
  if(target.kind==='text') return root.getByText(value,{exact:target.exact});
  return root.locator(value);
}
export async function uniqueLocator(page:Page,target:TargetLocator,inputs:RunInputs):Promise<Locator> {
  const locator=locate(page,target,inputs);
  await locator.waitFor({state:'visible',timeout:6000});
  if(await locator.count()!==1) throw new Error(`Ambiguous locator: ${target.value}`);
  return locator;
}
export async function field(page:Page,name:string):Promise<string> {
  const loc=page.locator(`[data-field="${name}"]`);
  if(await loc.count()!==1) throw new Error(`Expected one ${name} field; found ${await loc.count()}.`);
  return (await loc.innerText()).trim();
}
export async function observe(page:Page):Promise<Observation> {
  await page.waitForLoadState('domcontentloaded');
  const controls=await page.evaluate(() => {
    const items:ObservedControl[]=[];
    const helpers={
      clean(text:string|null|undefined){return (text||'').replace(/\s+/g,' ').trim();},
      visible(el:HTMLElement){return !!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('[aria-hidden="true"],.mat-horizontal-stepper-content-inactive');},
      accessibleText(el:Element){const copy=el.cloneNode(true) as Element;copy.querySelectorAll('[aria-hidden="true"]').forEach(node=>node.remove());return helpers.clean(copy.textContent);},
      push(role:string,name:string,locator:TargetLocator,value?:string){items.push({id:`control-${items.length+1}`,role,name,locator,value});},
    };
    for(const el of document.querySelectorAll<HTMLElement>('a[href],button,input:not([type=hidden]),select,textarea,[role="combobox"],[role="option"],[role="tab"]')) {
      if(!helpers.visible(el)||el.matches(':disabled,[aria-disabled="true"],input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[formcontrolname="password"]')) continue;
      const tag=el.tagName.toLowerCase();
      const labels=('labels' in el? Array.from((el as HTMLInputElement).labels||[]).map(helpers.accessibleText).filter(Boolean).join(' '):'')||'';
      const materialLabel=helpers.clean(el.closest('mat-form-field')?.querySelector('mat-label')?.textContent);
      const name=helpers.clean(el.getAttribute('aria-label')||labels||materialLabel||el.innerText||el.getAttribute('placeholder')||el.getAttribute('name'));
      const checkbox=tag==='input'&&(el as HTMLInputElement).type==='checkbox';
      const role=el.getAttribute('role')||(checkbox?'checkbox':tag==='a'?'link':tag==='button'?'button':tag==='select'?'combobox':'textbox');
      let locator:TargetLocator=labels?{kind:'label',value:labels,exact:true}:{kind:'role',role,value:name,exact:true};
      const formControl=el.getAttribute('formcontrolname');
      // formControlName is a rendered DOM attribute, not Angular component state.
      if((tag==='mat-select'||tag==='input')&&formControl&&/^[A-Za-z][A-Za-z0-9]*$/.test(formControl))locator={kind:'css',value:`${tag}[formcontrolname="${formControl}"]`,exact:true};
      else if(tag==='input'&&materialLabel)locator={kind:'label',value:materialLabel,exact:true};
      else if(tag==='input'&&!labels&&!el.getAttribute('aria-label')&&el.getAttribute('placeholder'))locator={kind:'css',value:`input[placeholder=${JSON.stringify(el.getAttribute('placeholder'))}]`,exact:true};
      const checkboxControl=checkbox?el.closest('mat-checkbox')?.getAttribute('formcontrolname'):undefined;
      if(checkboxControl&&/^[A-Za-z][A-Za-z0-9]*$/.test(checkboxControl))locator={kind:'css',value:`mat-checkbox[formcontrolname="${checkboxControl}"] label`,exact:true};
      const step=el.closest('mifosx-savings-account-details-step,mifosx-savings-account-terms-step,mifosx-savings-account-charges-step,mifosx-savings-account-preview-step,mifosx-client-general-step,mifosx-client-family-members-step,mifosx-client-preview-step');
      if(step)locator.scope=`${step.tagName.toLowerCase().startsWith('mifosx-client-')?'.mat-horizontal-stepper-content:not(.mat-horizontal-stepper-content-inactive) ':''}${step.tagName.toLowerCase()}:visible`;
      if(!name&&el.id) locator={kind:'css',value:`[id="${el.id.replaceAll('"','')}"]`,exact:true};
      if(!name&&!el.id) continue;
      const value=checkbox?((el as HTMLInputElement).checked?'checked':'unchecked'):'value' in el?String(el.value):tag==='mat-select'?helpers.clean(el.querySelector('.mat-mdc-select-value-text,.mat-select-value-text')?.textContent):undefined;
      helpers.push(role,name,locator,value);
    }
    // Mifos renders routerLink on table cells/rows rather than HTML anchors.
    // Resolve their selectors exclusively from the visible business references.
    for(const cell of document.querySelectorAll<HTMLElement>('mifosx-clients td.mat-column-displayName')){
      if(!helpers.visible(cell))continue;
      const reference=helpers.clean((cell.closest('tr')?.querySelector('td.mat-column-externalId mifosx-external-identifier') as HTMLElement|null)?.innerText);
      if(!/^\d{4,12}$/.test(reference))continue;
      helpers.push('link',`Open member ${reference} · ${helpers.clean(cell.innerText)}`,{kind:'css',value:`mifosx-clients tr:has(td.mat-column-externalId mifosx-external-identifier span:text-is(${JSON.stringify(reference)})) td.mat-column-displayName`,exact:true});
    }
    for(const table of document.querySelectorAll<HTMLElement>('mifosx-clients-view table')){
      const headings=Array.from(table.querySelectorAll('th')).map(th=>helpers.clean((th as HTMLElement).innerText));
      if(!helpers.visible(table)||!headings.includes('Savings Product')||!headings.includes('Last Active'))continue;
      for(const account of table.querySelectorAll<HTMLElement>('mifosx-account-number')){
        if(!helpers.visible(account))continue;
        const reference=helpers.clean(account.innerText);
        if(!/^[A-Za-z0-9-]{3,32}$/.test(reference))continue;
        helpers.push('link',`View account ${reference}`,{kind:'css',value:`mifosx-clients-view table:has(th:text-is("Savings Product")):has(th:text-is("Last Active")) mifosx-account-number span:text-is(${JSON.stringify(reference)})`,exact:true});
      }
    }
    return items;
  });
  const secrets=page.locator('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[formcontrolname="password"]');
  return {url:page.url(),title:await page.title(),text:(await page.locator('body').innerText()).slice(0,16000),controls,screenshot:`data:image/jpeg;base64,${(await page.screenshot({type:'jpeg',quality:65,animations:'disabled',mask:[secrets]})).toString('base64')}`};
}
