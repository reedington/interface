import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountChoiceSchema, accountSelectionSchema, capabilityContractDescription, capabilitySchema, inputSchema, outputJsonSchemas, outputSchemas, taskInputJsonSchemas, type RunInputs } from '../src/shared/contracts.js';
import { authoredCapabilities, digest } from '../src/server/capabilities.js';
import { canonicalMemberDate, OutputContractError, TaskInputContractError, validateFinalOutput, validateTaskInputs } from '../src/server/output-contracts.js';

const inputs:RunInputs=inputSchema.parse({clientReference:'10001',accountReference:'SAV-1001',product:'Growth Savings',externalReference:'QA-TEST-1'});
const balance={clientReference:'10001',accountReference:'SAV-1001',balance:'12540.75',currency:'USD',status:'Active'};
const prepared={clientReference:'10001',product:'Growth Savings',externalReference:'QA-TEST-1'};
const submitted={...prepared,applicationReference:'APP-123ABC',status:'Pending Approval'};
const memberInputs:RunInputs={...inputs,clientReference:'756182668148',accountReference:'',firstName:'Avery',lastName:'Parker'};
const member={clientReference:memberInputs.clientReference,memberAccountNumber:'000000003',firstName:'Avery',lastName:'Parker',memberName:'Avery Parker',office:'Head Office',status:'Active',activationDate:'22 September 2026'};
function invalid(action:()=>unknown,field?:string){
  assert.throws(action,(error:unknown)=>error instanceof OutputContractError&&(!field||error.fields.includes(field)));
}

test('both existing target output shapes validate without adding unsupported required fields',()=>{
  assert.deepEqual(validateFinalOutput({task:'balance',inputs,output:balance}),balance);
  assert.deepEqual(validateFinalOutput({task:'prepare',targetId:'local-banking-lab',inputs,output:prepared}),prepared);
  const mifosPreview={...prepared,currency:'USD',submittedOn:'22 September 2026',nominalAnnualInterest:'0 %',previewText:'Growth Savings · USD · QA-TEST-1'};
  assert.deepEqual(validateFinalOutput({task:'prepare',targetId:'mifos-x',inputs,output:mifosPreview}),mifosPreview);
  assert.deepEqual(validateFinalOutput({task:'submit',targetId:'local-banking-lab',inputs,output:submitted}),submitted);
  const mifosSubmitted={...submitted,applicationReference:'000000007',currency:'USD',status:'Submitted and pending approval'};
  assert.deepEqual(validateFinalOutput({task:'submit',targetId:'mifos-x',inputs,output:mifosSubmitted}),mifosSubmitted);
  assert.deepEqual(validateFinalOutput({task:'member',targetId:'mifos-x',inputs:memberInputs,resolvedInputs:{memberActivationDate:'9/22/2026'},output:member}),member);
});

test('balance rejects malformed money, wrong currency/status/identity and arbitrary output fields',()=>{
  for(const amount of [12540.75,'$12,540.75','12,540.75','1e3','NaN','12.5','12.500','+12.50',' 12.50','01.00']){
    invalid(()=>validateFinalOutput({task:'balance',inputs,output:{...balance,balance:amount}}),'balance');
  }
  const negative=validateFinalOutput({task:'balance',inputs,output:{...balance,balance:'-12.50'}});
  assert.ok('balance' in negative);assert.equal(negative.balance,'-12.50');
  for(const change of [{currency:'EUR'},{status:'Closed'},{clientReference:'10002'},{accountReference:'SAV-1002'},{accountReference:'../../private'}]){
    invalid(()=>validateFinalOutput({task:'balance',inputs,output:{...balance,...change}}));
  }
  invalid(()=>validateFinalOutput({task:'balance',inputs,output:{...balance,sessionToken:'SENSITIVE-CANARY'}}),'output');
});

test('account resolution binds a missing caller choice and cannot replace an explicit account',()=>{
  const absent={...inputs,accountReference:''};
  invalid(()=>validateFinalOutput({task:'balance',inputs:absent,output:balance}),'inputs.accountReference');
  assert.deepEqual(validateFinalOutput({task:'balance',inputs:absent,resolvedInputs:{accountReference:'SAV-1001'},output:balance}),balance);
  invalid(()=>validateFinalOutput({task:'balance',inputs,resolvedInputs:{accountReference:'SAV-1002'},output:{...balance,accountReference:'SAV-1002'}}),'resolvedInputs.accountReference');
  invalid(()=>validateFinalOutput({task:'balance',inputs,resolvedInputs:{clientReference:'10002'},output:balance}),'resolvedInputs.clientReference');
});

test('prepared/submitted contracts bind product and reference and never confuse review with persistence',()=>{
  for(const task of ['prepare','submit'] as const){
    const output=task==='prepare'?prepared:submitted;
    for(const change of [{clientReference:'10002'},{product:'Everyday Savings'},{externalReference:'QA-OTHER'}]){
      invalid(()=>validateFinalOutput({task,inputs,output:{...output,...change}}));
    }
  }
  invalid(()=>validateFinalOutput({task:'submit',inputs,output:prepared}),'applicationReference');
  invalid(()=>validateFinalOutput({task:'prepare',inputs,output:submitted}),'output');
  invalid(()=>validateFinalOutput({task:'submit',targetId:'mifos-x',inputs,output:submitted}),'status');
  invalid(()=>validateFinalOutput({task:'submit',inputs,output:{...submitted,status:'Active'}}),'status');
  invalid(()=>validateFinalOutput({task:'submit',inputs,output:{...submitted,applicationReference:''}}),'applicationReference');
  invalid(()=>validateFinalOutput({task:'prepare',inputs,output:{...prepared,currency:'NGN'}}),'currency');
  invalid(()=>validateFinalOutput({task:'prepare',inputs,output:prepared,declaredOutput:'submitted-v1'}),'declaredOutput');
});

test('member output binds exact names, generated identity, office, status and the observed calendar date',()=>{
  const context={task:'member' as const,targetId:'mifos-x' as const,inputs:memberInputs,resolvedInputs:{memberActivationDate:'9/22/2026'}};
  for(const change of [{firstName:'Taylor'},{firstName:' Avery '},{lastName:'Morgan'},{memberName:'Avery Morgan'},{clientReference:'10002'},{memberAccountNumber:''},{office:'Branch 2'},{status:'Pending'},{activationDate:'23 September 2026'}]){
    invalid(()=>validateFinalOutput({...context,output:{...member,...change}}));
  }
  invalid(()=>validateFinalOutput({...context,resolvedInputs:undefined,output:member}),'inputs.memberActivationDate');
  invalid(()=>validateFinalOutput({...context,targetId:'local-banking-lab',output:member}),'targetId');
  invalid(()=>validateFinalOutput({...context,resolvedInputs:{memberActivationDate:'2/30/2026'},output:member}),'inputs.memberActivationDate');
  invalid(()=>validateFinalOutput({...context,inputs:{...memberInputs,memberActivationDate:'9/21/2026'},output:member}),'resolvedInputs.memberActivationDate');
  assert.notEqual(member.memberAccountNumber,member.clientReference,'Generated member number is deliberately distinct from external reference');
});

test('task input contracts require only relevant explicit arguments and reject invented identity defaults',()=>{
  assert.deepEqual(validateTaskInputs('balance',{clientReference:'10001'}),{clientReference:'10001'});
  assert.deepEqual(validateTaskInputs('prepare',inputs),prepared,'Legacy unrelated account/name fields are projected away');
  for(const task of ['prepare','submit'] as const){
    assert.throws(()=>validateTaskInputs(task,{clientReference:'10001',product:'Growth Savings'}),TaskInputContractError);
    assert.throws(()=>validateTaskInputs(task,{clientReference:'10001',externalReference:'QA-1'}),TaskInputContractError);
  }
  assert.throws(()=>validateTaskInputs('balance',{}),TaskInputContractError);
  assert.throws(()=>validateTaskInputs('member',{clientReference:'10003',firstName:'Avery'}),TaskInputContractError);
  assert.deepEqual(validateTaskInputs('member',{clientReference:'10003',firstName:'  Anne   Marie ',lastName:"O'Neil"}),{clientReference:'10003',firstName:'Anne Marie',lastName:"O'Neil"});
  for(const date of ['2026-09-22','31/12/2026','2/29/2025','22 Unknown 2026','9/22/2026 trailing']){
    assert.throws(()=>validateTaskInputs('member',{...memberInputs,memberActivationDate:date}),TaskInputContractError);
  }
  assert.equal(canonicalMemberDate('2/29/2024'),'29 February 2024');
  assert.equal(canonicalMemberDate('29 February 2025'),undefined);
});

test('validation errors disclose field names without rejected output, secret or personal values',()=>{
  const secret='sk-SENSITIVE-CANARY';
  try{validateFinalOutput({task:'balance',inputs,output:{...balance,balance:secret,password:secret}});assert.fail('Must reject');}
  catch(error){assert.ok(error instanceof OutputContractError);assert.equal(error.code,'OUTPUT_CONTRACT_INVALID');assert.equal(JSON.stringify(error).includes(secret),false);assert.equal(error.message.includes(secret),false);}
  const uncertain={effect:'unknown',result:'failed',output:{...submitted,status:'Active'}};
  const before=JSON.stringify(uncertain);
  invalid(()=>validateFinalOutput({task:'submit',inputs,output:uncertain.output}));
  assert.equal(JSON.stringify(uncertain),before,'Contract validation cannot falsely mark an uncertain side effect verified');
});

test('JSON Schema describes the existing IDs without mutating historical artifact content or digests',()=>{
  for(const capability of authoredCapabilities()){
    const original=JSON.stringify(capability),originalDigest=capability.digest;
    const description=capabilityContractDescription(capability.task);
    assert.equal(description.inputContractId,capability.inputs);assert.equal(description.outputContractId,capability.output);
    assert.ok(JSON.parse(JSON.stringify(description)).outputSchema.properties);
    assert.equal(JSON.stringify(capability),original);assert.equal(digest(capabilitySchema.parse(capability)),originalDigest);
  }
  for(const [id,schema] of Object.entries(outputSchemas)){
    const json=outputJsonSchemas[id as keyof typeof outputSchemas];
    assert.deepEqual(Object.keys(json.properties as object).sort(),Object.keys(schema.shape).sort());
    assert.equal(json.additionalProperties,false);
  }
  assert.deepEqual(taskInputJsonSchemas.member.required,['clientReference','firstName','lastName']);
  assert.deepEqual(taskInputJsonSchemas.prepare.required,['clientReference','product','externalReference']);
  assert.deepEqual(taskInputJsonSchemas.balance.required,['clientReference']);
  assert.deepEqual(outputJsonSchemas['prepared-v1'].required,['clientReference','product','externalReference']);
});

test('account choices reject arbitrary locator strings, oversized UI labels and unbounded selection lists',()=>{
  const choice={accountReference:'SAV-1001',accountNumber:'000000003',product:'Growth Savings',status:'Active'};
  assert.deepEqual(accountChoiceSchema.parse(choice),choice);
  for(const change of [{accountReference:'button#submit'},{accountNumber:'../../private'},{product:''},{product:'x'.repeat(121)},{status:'x'.repeat(81)},{url:'https://example.com'}]){
    assert.equal(accountChoiceSchema.safeParse({...choice,...change}).success,false);
  }
  assert.equal(accountSelectionSchema.safeParse({clientReference:'10001',choices:[choice]}).success,true);
  assert.equal(accountSelectionSchema.safeParse({clientReference:'10001',choices:Array(101).fill(choice)}).success,false);
  assert.equal(accountSelectionSchema.safeParse({clientReference:'10001',choices:[]}).success,false);
});
