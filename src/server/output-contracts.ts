import { outputSchemas, taskInputSchemas, taskOutputContractIds, type FinalBusinessOutput, type OutputContractId, type RunInputs, type TaskInput, type TaskKind } from '../shared/contracts.js';

export class OutputContractError extends Error {
  readonly code='OUTPUT_CONTRACT_INVALID';
  constructor(readonly fields:string[]){super(`Final output failed its declared contract or requested-input binding (${fields.join(', ')}).`);this.name='OutputContractError';}
}
export class TaskInputContractError extends Error {
  readonly code='INPUT_CONTRACT_INVALID';
  constructor(readonly fields:string[]){super(`Required task inputs are missing or invalid (${fields.join(', ')}).`);this.name='TaskInputContractError';}
}
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
/** Accepted visible US date forms only. No locale guessing or Date.parse coercion. */
export function canonicalMemberDate(value:string):string|undefined{
  const short=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/),long=value.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if(!short&&!long)return undefined;
  const month=short?Number(short[1]):months.indexOf(long![2])+1;
  const day=Number(short?.[2]??long![1]),year=Number(short?.[3]??long![3]);
  if(year<1000||!month)return undefined;
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return undefined;
  return `${day} ${months[month-1]} ${year}`;
}
export function validateTaskInputs(task:TaskKind,inputs:unknown):TaskInput{
  const schema=taskInputSchemas[task];
  if(!schema)throw new TaskInputContractError(['task']);
  const parsed=schema.safeParse(inputs);
  if(!parsed.success)throw new TaskInputContractError([...new Set(parsed.error.issues.map(issue=>issue.path.join('.')||'inputs'))]);
  if(task==='member'&&'memberActivationDate' in parsed.data&&parsed.data.memberActivationDate&&!canonicalMemberDate(parsed.data.memberActivationDate))throw new TaskInputContractError(['memberActivationDate']);
  return parsed.data;
}
export interface FinalOutputContext {
  task:TaskKind;
  targetId?:'local-banking-lab'|'mifos-x';
  inputs:RunInputs;
  resolvedInputs?:Partial<RunInputs>;
  output:unknown;
  declaredOutput?:OutputContractId;
}

/**
 * Validate terminal successful business output, never an intermediate checkpoint.
 * This pure function cannot change a run or turn an unknown external effect into
 * a verified one. The caller must preserve unknown effect when validation fails
 * after dispatch, and validate reconciliation before changing its result/effect.
 */
export function validateFinalOutput(context:FinalOutputContext):FinalBusinessOutput{
  const {task,inputs,resolvedInputs,output,declaredOutput}=context;
  const contract=taskOutputContractIds[task];
  if(!contract||declaredOutput&&declaredOutput!==contract)throw new OutputContractError(['declaredOutput']);
  if(context.targetId!==undefined&&!['local-banking-lab','mifos-x'].includes(context.targetId))throw new OutputContractError(['targetId']);
  try{validateTaskInputs(task,inputs);}catch(error){
    if(error instanceof TaskInputContractError)throw new OutputContractError(error.fields.map(field=>`inputs.${field}`));
    throw error;
  }
  const parsed=outputSchemas[contract].safeParse(output);
  if(!parsed.success)throw new OutputContractError([...new Set(parsed.error.issues.map(issue=>issue.path.join('.')||'output'))]);
  const result=parsed.data;
  const invalid:string[]=[];
  const equal=(field:string,actual:unknown,expected:unknown)=>{if(actual!==expected)invalid.push(field);};
  equal('clientReference',result.clientReference,inputs.clientReference);
  // A UI-derived value fills a missing parameter; it cannot override an explicit
  // caller choice even if the resulting output would otherwise match it.
  for(const key of ['clientReference','accountReference','product','externalReference','firstName','lastName','memberActivationDate'] as const){
    if(inputs[key]&&resolvedInputs?.[key]!==undefined&&resolvedInputs[key]!==inputs[key])invalid.push(`resolvedInputs.${key}`);
  }
  if(task==='balance'&&'accountReference' in result){
    const account=inputs.accountReference||resolvedInputs?.accountReference;
    if(!account)invalid.push('inputs.accountReference');
    else equal('accountReference',result.accountReference,account);
  }
  if((task==='prepare'||task==='submit')&&'product' in result){
    equal('product',result.product,inputs.product);equal('externalReference',result.externalReference,inputs.externalReference);
  }
  if(task==='submit'&&'status' in result){
    equal('status',result.status,context.targetId==='mifos-x'?'Submitted and pending approval':'Pending Approval');
  }
  if(task==='member'&&'firstName' in result){
    if(context.targetId!=='mifos-x')invalid.push('targetId');
    equal('firstName',result.firstName,inputs.firstName);equal('lastName',result.lastName,inputs.lastName);
    equal('memberName',result.memberName,`${inputs.firstName} ${inputs.lastName}`);
    const date=inputs.memberActivationDate||resolvedInputs?.memberActivationDate;
    const canonical=date?canonicalMemberDate(date):undefined;
    if(!canonical)invalid.push('inputs.memberActivationDate');
    else equal('activationDate',result.activationDate,canonical);
  }
  if(invalid.length)throw new OutputContractError([...new Set(invalid)]);
  return result;
}
