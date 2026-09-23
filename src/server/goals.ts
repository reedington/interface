import { randomUUID } from 'node:crypto';
import { inputSchema, type GoalResolution, type RunInputs, type TaskKind } from '../shared/contracts.js';

export const baselineId=(task:TaskKind)=>`lab-${task}-us-v1`;
export const goalExamples=[
  'Look up member 10001 and read their current savings balance',
  'Prepare a new savings sub-account for member 10002 and stop at review',
  'Submit a savings application for member 10001 after my approval',
];

/**
 * Conservative, offline routing for the registered credit-union workflows.
 * This is not model discovery. Unrecognized/ambiguous intent requires clarification.
 * The browser still discovers the member/account state; this module never reads it.
 */
export function resolveGoal(raw:string,defaults?:Partial<RunInputs>):GoalResolution {
  const goal=raw.trim(),text=goal.toLowerCase().replace(/[’‘]/g,"'");
  const clarify=(question:string|string[],explanation='This goal needs clarification before the browser can start.'):GoalResolution=>({status:'clarification',goal,explanation,questions:Array.isArray(question)?question:[question]});
  if(!goal||goal.length>1200)return clarify('Describe one member operation in 1–1,200 characters.');
  if(/\b(?:do not|don't|never|without)\s+(?:read|show|look|view|check|retrieve|fetch)\b/.test(text))return clarify('State the one operation you do want performed. I will not turn a negated request into an action.');
  if(/\b(?:eur|gbp|ngn|cad|aud|jpy|euros?|pounds?|naira|yen|rupees?)\b|[€£₦¥]/i.test(goal))return clarify('This local US credit union exposes USD balances only. Would you like the current USD savings balance?');
  if(/\b(?:transfer|withdraw|pay|payment|purchase|delete|remove|close|disburse|wire|loan|mortgage|password|export|email|send\s+to)\b/.test(text))
    return clarify('This target supports reading a savings balance, preparing a savings application, or submitting one after approval. Which of those do you need?','The requested action is outside the registered workflows.');
  if(/\b(?:do not|don't|never|without)\s+(?:create|register|add|onboard)\b/.test(text))return clarify('State the operation you do want performed. A negated creation request will not create a member.');
  const newMember=/\b(?:new\s+(?:member|customer|client)|(?:create|register|add|onboard)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(?:member|customer|client))\b/.test(text);
  const memberMatches=[...text.matchAll(/\b(?:member|client)(?:\s+(?:number|reference|id))?\s*[:#-]?\s*(\d{4,12})\b/g)].map(m=>m[1]);
  const members=[...new Set(memberMatches)];
  if(members.length>1)return clarify('Which single member should this run act on? Use a separate run for each member.');
  if(/\b(?:or|and)\s+(?:(?:member|client)\s*)?\d{4,12}\b/.test(text))return clarify('The goal contains multiple or alternative references. State one member and, if needed, one explicitly labeled account.');
  const clientReference=members[0]||defaults?.clientReference;
  if(newMember){
    const details=()=>({...clarify('Enter the new member’s first name, last name, and a unique numeric member reference.','Create one individual member in local Mifos. You will review the exact customer preview before creation. A savings application is a separate next step.'),clarificationKind:'new_member' as const});
    if(/\b(?:savings|balance|login|sign[ -]?in)\b/.test(text))return details();
    const firstName=goal.match(/\bfirst\s+name\s*[:=]?\s*"([^"]+)"/i)?.[1]??defaults?.firstName;
    const lastName=goal.match(/\blast\s+name\s*[:=]?\s*"([^"]+)"/i)?.[1]??defaults?.lastName;
    if(!clientReference||!firstName||!lastName)return details();
    const parsed=inputSchema.safeParse({clientReference,accountReference:'',product:'Everyday Savings',externalReference:clientReference,firstName,lastName});
    if(!parsed.success)return details();
    return {status:'ready',goal,task:'member',inputs:parsed.data,capabilityId:'mifos-member-v1',explanation:'Prepare a new individual member in Head Office, active from the business date shown by Mifos. Review the exact preview and approve creation once. No savings account is opened in this operation.',questions:[]};
  }
  if(!clientReference){
    const accountRequest=/\b(?:prepare|draft|fill|open|create|new|add|submit)\b/.test(text)&&/\b(?:application|sub[ -]?account|savings|account)\b/.test(text);
    if(accountRequest&&(/\bexisting\s+(?:member|customer|client)\b/.test(text)||/\b(?:prepare|draft|fill)\b/.test(text)))return clarify('Which member reference should this savings application use? For example: “Prepare an Everyday Savings application for member 10001 and stop at review.”');
    if(accountRequest)return {...clarify('Do you need a new member/customer first, or a savings application for an existing member?','“For me” is not linked to a member. Choose the starting point; nothing will be created until you review and approve the operation.'),clarificationKind:'account_intent'};
    return clarify('Which member reference should I use? For example: “Look up member 10001 and read their savings balance.”');
  }
  const accountMatches=[...goal.matchAll(/\bSAV-[A-Za-z0-9-]+\b/gi)].map(m=>m[0].toUpperCase());
  const explicitAccount=goal.match(/\baccount\s+(?:(?:number|reference|id)\s*[:#]?\s*([A-Za-z0-9-]+)|[:#]?\s*((?:[A-Za-z]+-)?\d[A-Za-z0-9-]*))/i);
  if(explicitAccount&&!/^SAV-[A-Za-z0-9-]+$/i.test(explicitAccount[1]||explicitAccount[2]))return clarify('Use the exact savings account reference shown in the application, such as SAV-1001. I will not substitute a different account for the one named.');
  if(new Set(accountMatches).size>1)return clarify('Which single savings account should this run inspect?');
  const wantsBalance=/\bbalance\b/.test(text);
  const application=/\b(?:application|sub[ -]?account|savings|account)\b/.test(text);
  const prepare=/\b(?:prepare|draft|fill|open|create|new|add)\b/.test(text)&&application;
  const negatedSubmit=/\b(?:do not|don't|never|without)\s+(?:actually\s+)?submit(?:ting)?\b/.test(text);
  const reviewOnly=/\b(?:stop|pause|end)\s+(?:at|before|on)\s+(?:the\s+)?(?:review|preview|submit|submission)|\breview only\b/.test(text)||negatedSubmit;
  const submit=/\bsubmit(?:ting)?\b/.test(text)&&application&&!negatedSubmit;
  if(wantsBalance&&(prepare||submit))return clarify('Do you want a balance lookup or a new application? Start with one operation.');
  if(submit&&reviewOnly)return clarify('Should this run stop at review, or submit after your approval? Choose one outcome.');
  let task:TaskKind;
  if(wantsBalance)task='balance';
  else if(submit)task='submit';
  else if(prepare&&(/\b(?:prepare|draft|fill)\b/.test(text)||reviewOnly))task='prepare';
  else if(prepare)return clarify('Should I prepare the savings application and stop at review, or submit it after your approval? This application creates a pending application; it does not activate a real account.');
  else return clarify('Do you want to read a savings balance, prepare an application for review, or submit an application after approval?');
  if(/\b(?:available|withdrawable)\s+(?:savings\s+)?balance\b/.test(text))return clarify('The registered workflow reads the current ledger balance, not an available-to-withdraw balance. Would you like the current savings balance?');
  if(/\b(?:checking|loan|business|retirement)\b/.test(text))return clarify('The registered workflows support savings accounts. Which savings operation should I perform?');
  const growth=/\bgrowth savings\b/i.test(goal),everyday=/\beveryday savings\b/i.test(goal);
  const genericQualifiers=new Set(['a','the','new','current','their','my','your','his','her','its','existing','read','show','view','prepare','create','open','everyday','growth']);
  const unsupportedProduct=[...text.matchAll(/\b([a-z]+)\s+savings\b/g)].find(m=>!genericQualifiers.has(m[1]));
  if(unsupportedProduct)return clarify('The local application supports Everyday Savings and Growth Savings applications. Name one of those products, or ask for the member’s current savings balance.');
  if(growth&&everyday)return clarify('Choose one savings product: Everyday Savings or Growth Savings.');
  if(task==='balance'&&growth)return clarify('The current balance capability supports the seeded Everyday Savings accounts. Would you like that balance, or do you want to prepare a Growth Savings application?');
  const reference=goal.match(/\b(?:external|application)\s+reference\s*(?:is\s+|[:#]\s*)?["']?([A-Za-z0-9-]{1,40})/i)?.[1];
  const inputs=inputSchema.parse({
    clientReference,
    accountReference:accountMatches[0]??defaults?.accountReference??'',
    product:growth?'Growth Savings':everyday?'Everyday Savings':defaults?.product??'Everyday Savings',
    externalReference:reference??defaults?.externalReference??`CU-${randomUUID().slice(0,8).toUpperCase()}`,
  });
  if(task==='balance'&&inputs.product!=='Everyday Savings')return clarify('This balance capability verifies Everyday Savings. Choose that product for balance lookup.');
  const explanation=task==='balance'
    ? 'Read the current savings ledger balance in USD. If no account is specified, require exactly one savings account on the member page.'
    : task==='prepare'?'Prepare the savings application and stop at review. No application is submitted.'
    : 'Prepare a savings application, show its exact preview for your approval, then submit once. The result is a pending application, not an active account.';
  return {status:'ready',goal,task,inputs,capabilityId:baselineId(task),explanation,questions:[]};
}

export function reviewedGoalProblem(goal:string,task:TaskKind,inputs:RunInputs):string|undefined {
  const result=resolveGoal(goal,inputs);
  if(result.status!=='ready')return result.questions.join(' ');
  if(result.task!==task)return 'The selected operation conflicts with the goal. Review the goal again.';
  const relevant:(keyof RunInputs)[]=task==='member'?['clientReference','firstName','lastName']:task==='balance'?['clientReference','accountReference','product']:['clientReference','product','externalReference'];
  for(const key of relevant)
    if(result.inputs![key]!==inputs[key])return `The ${key==='clientReference'?'member reference':key} conflicts with the goal. Update the goal and review it again.`;
}
