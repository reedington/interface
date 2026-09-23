import { z } from 'zod';

export const taskSchema = z.enum(['balance', 'prepare', 'submit', 'member']);
export type TaskKind = z.infer<typeof taskSchema>;
export const scenarioSchema = z.enum(['normal', 'not_found', 'validation', 'permission', 'session_expired', 'slow', 'unexpected_dialog', 'commit_unknown']);
export type Scenario = z.infer<typeof scenarioSchema>;
export const inputSchema = z.object({
  clientReference: z.string().regex(/^\d{4,12}$/).default('10001'),
  accountReference: z.string().regex(/^(?:[A-Za-z0-9-]{3,32})?$/).default('SAV-1001'),
  product: z.enum(['Everyday Savings', 'Growth Savings']).default('Everyday Savings'),
  externalReference: z.string().regex(/^[A-Za-z0-9-]{1,40}$/).default('LOCAL-001'),
  firstName: z.string().trim().min(1).max(50).regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u).transform(value=>value.replace(/ +/g,' ')).optional(),
  lastName: z.string().trim().min(1).max(50).regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u).transform(value=>value.replace(/ +/g,' ')).optional(),
  memberActivationDate: z.string().trim().min(1).max(40).optional(),
});
export type RunInputs = z.infer<typeof inputSchema>;

// These registries describe existing contract IDs without adding fields to a
// capability's serialized/digested content. Zod 3 has no built-in JSON Schema
// export, so each reusable field carries its JSON Schema alongside its parser.
type JsonSchema = Record<string, unknown>;
const contractField = <T extends z.ZodTypeAny>(schema:T,json:JsonSchema) => ({schema,json});
const memberReferencePattern='^[0-9]{4,12}$';
const accountReferencePattern='^[A-Za-z0-9-]{3,32}$';
const identifierPattern='^[A-Za-z0-9-]{1,40}$';
const namePattern="^[\\p{L}\\p{M}][\\p{L}\\p{M} .'-]*$";
const moneyPattern='^-?(?:0|[1-9][0-9]*)\\.[0-9]{2}$';
const normalizedName=z.string().trim().min(1).max(50).regex(new RegExp(namePattern,'u')).transform(value=>value.replace(/ +/g,' '));
const visibleName=z.string().min(1).max(50).regex(new RegExp(namePattern,'u')).refine(value=>value===value.trim().replace(/ +/g,' '),'Expected the exact normalized member name.');
const contractFields={
  clientReference:contractField(z.string().regex(new RegExp(memberReferencePattern)),{type:'string',pattern:memberReferencePattern,description:'Unique member external reference; never assume this is the target-generated member account number.'}),
  accountReference:contractField(z.string().regex(new RegExp(accountReferencePattern)),{type:'string',pattern:accountReferencePattern,description:'Visible savings-account identifier, supplied by the caller or resolved from the verified member UI.'}),
  product:contractField(z.enum(['Everyday Savings','Growth Savings']),{type:'string',enum:['Everyday Savings','Growth Savings'],description:'Supported USD savings product name.'}),
  externalReference:contractField(z.string().regex(new RegExp(identifierPattern)),{type:'string',pattern:identifierPattern,description:'Caller-supplied unique application reference, distinct from the member reference.'}),
  firstName:contractField(normalizedName,{type:'string',minLength:1,maxLength:50,pattern:namePattern,description:'First name; surrounding/repeated ASCII spaces are normalized by the runtime.'}),
  lastName:contractField(normalizedName,{type:'string',minLength:1,maxLength:50,pattern:namePattern,description:'Last name; surrounding/repeated ASCII spaces are normalized by the runtime.'}),
  memberActivationDate:contractField(z.string().min(1).max(40),{type:'string',minLength:1,maxLength:40,description:'Optional explicit US M/D/YYYY or D Month YYYY date. If omitted, resolve the current visible business date before approval.'}),
  balance:contractField(z.string().max(40).regex(new RegExp(moneyPattern)),{type:'string',maxLength:40,pattern:moneyPattern,description:'Signed USD ledger amount as a decimal string with exactly two fraction digits; no currency symbol, grouping, exponent, or binary float.'}),
  currency:contractField(z.literal('USD'),{type:'string',const:'USD'}),
  activeStatus:contractField(z.literal('Active'),{type:'string',const:'Active'}),
  pendingStatus:contractField(z.enum(['Pending Approval','Submitted and pending approval']),{type:'string',enum:['Pending Approval','Submitted and pending approval'],description:'Lab and Mifos labels for a persisted application awaiting approval; not an active savings account.'}),
  applicationReference:contractField(z.string().regex(new RegExp(identifierPattern)),{type:'string',pattern:identifierPattern,description:'Persisted target-generated application identifier.'}),
  memberAccountNumber:contractField(z.string().regex(/^[A-Za-z0-9-]{1,32}$/),{type:'string',pattern:'^[A-Za-z0-9-]{1,32}$',description:'Target-generated member account number, not the supplied external reference.'}),
  memberName:contractField(z.string().min(3).max(101),{type:'string',minLength:3,maxLength:101,description:'Visible full name; must match firstName plus lastName.'}),
  office:contractField(z.literal('Head Office'),{type:'string',const:'Head Office'}),
  activationDate:contractField(z.string().min(1).max(40),{type:'string',minLength:1,maxLength:40,description:'Visible D Month YYYY activation date; must equal the requested or UI-resolved date.'}),
  submittedOn:contractField(z.string().min(1).max(64),{type:'string',minLength:1,maxLength:64,description:'Optional visible submission date supplied by the Mifos preview.'}),
  nominalAnnualInterest:contractField(z.string().max(40).regex(/^\d+(?:\.\d+)?\s*%$/),{type:'string',maxLength:40,pattern:'^[0-9]+(?:\\.[0-9]+)?\\s*%$',description:'Optional visible interest percentage supplied by the Mifos preview.'}),
  previewText:contractField(z.string().min(1).max(16000),{type:'string',minLength:1,maxLength:16000,description:'Optional full visible Mifos preview used for approval binding; treat as sensitive evidence, not public logs.'}),
};
const applicationOutputFields={clientReference:contractFields.clientReference.schema,product:contractFields.product.schema,externalReference:contractFields.externalReference.schema};
export const outputSchemas={
  'balance-v1':z.object({clientReference:contractFields.clientReference.schema,accountReference:contractFields.accountReference.schema,balance:contractFields.balance.schema,currency:contractFields.currency.schema,status:contractFields.activeStatus.schema}).strict(),
  'prepared-v1':z.object({...applicationOutputFields,currency:contractFields.currency.schema.optional(),submittedOn:contractFields.submittedOn.schema.optional(),nominalAnnualInterest:contractFields.nominalAnnualInterest.schema.optional(),previewText:contractFields.previewText.schema.optional()}).strict(),
  'submitted-v1':z.object({...applicationOutputFields,applicationReference:contractFields.applicationReference.schema,status:contractFields.pendingStatus.schema,currency:contractFields.currency.schema.optional()}).strict(),
  'member-v1':z.object({clientReference:contractFields.clientReference.schema,memberAccountNumber:contractFields.memberAccountNumber.schema,firstName:visibleName,lastName:visibleName,memberName:contractFields.memberName.schema,office:contractFields.office.schema,status:contractFields.activeStatus.schema,activationDate:contractFields.activationDate.schema}).strict(),
};
export type OutputContractId=keyof typeof outputSchemas;
export type FinalBusinessOutput=z.infer<(typeof outputSchemas)[OutputContractId]>;
export const taskOutputContractIds:Record<TaskKind,OutputContractId>={balance:'balance-v1',prepare:'prepared-v1',submit:'submitted-v1',member:'member-v1'};

// Invocation validation projects onto task fields. Legacy RunInputs can retain
// unrelated defaults, but those defaults are not required by the task contract.
export const taskInputSchemas={
  balance:z.object({clientReference:contractFields.clientReference.schema,accountReference:contractFields.accountReference.schema.or(z.literal('')).optional(),product:contractFields.product.schema.optional()}),
  prepare:z.object({...applicationOutputFields}),
  submit:z.object({...applicationOutputFields}),
  member:z.object({clientReference:contractFields.clientReference.schema,firstName:contractFields.firstName.schema,lastName:contractFields.lastName.schema,memberActivationDate:contractFields.memberActivationDate.schema.optional()}),
};
export type TaskInput= z.infer<(typeof taskInputSchemas)[TaskKind]>;
export const taskInputDescriptions:Record<TaskKind,string>={
  balance:'Read one active USD savings account for an exact member. If accountReference is missing or empty, resolve it from that member’s visible accounts; never invent an identifier. Product is an optional account-selection constraint.',
  prepare:'Prepare the exact member/product/application-reference combination and stop at verified review without a persisted application.',
  submit:'Prepare that exact application, require a fresh approval of the complete visible preview, then verify one persisted pending application. Submission does not approve or activate savings.',
  member:'Create an active individual member in Head Office with a new external reference and explicit first/last name. Resolve the visible business date when omitted, require exact-preview approval, and return the generated member number. No savings account is created.',
};
function objectJsonSchema(title:string,properties:Record<string,JsonSchema>,required:string[],additionalProperties=false):JsonSchema{
  return {$schema:'https://json-schema.org/draft/2020-12/schema',title,type:'object',properties,required,additionalProperties};
}
const jsonFields=(keys:(keyof typeof contractFields)[])=>Object.fromEntries(keys.map(key=>[key,contractFields[key].json]));
export const outputJsonSchemas:Record<OutputContractId,JsonSchema>={
  'balance-v1':objectJsonSchema('balance-v1',{...jsonFields(['clientReference','accountReference','balance','currency']),status:contractFields.activeStatus.json},['clientReference','accountReference','balance','currency','status']),
  'prepared-v1':objectJsonSchema('prepared-v1',jsonFields(['clientReference','product','externalReference','currency','submittedOn','nominalAnnualInterest','previewText']),['clientReference','product','externalReference']),
  'submitted-v1':objectJsonSchema('submitted-v1',{...jsonFields(['clientReference','product','externalReference','applicationReference','currency']),status:contractFields.pendingStatus.json},['clientReference','product','externalReference','applicationReference','status']),
  'member-v1':objectJsonSchema('member-v1',{...jsonFields(['clientReference','memberAccountNumber','firstName','lastName','memberName','office','activationDate']),status:contractFields.activeStatus.json},['clientReference','memberAccountNumber','firstName','lastName','memberName','office','status','activationDate']),
};
export const taskInputJsonSchemas:Record<TaskKind,JsonSchema>={
  balance:objectJsonSchema('balance inputs',{...jsonFields(['clientReference','product']),accountReference:{anyOf:[contractFields.accountReference.json,{type:'string',const:''}],description:'Omit or leave empty to select from the verified member UI.'}},['clientReference'],true),
  prepare:objectJsonSchema('prepare inputs',jsonFields(['clientReference','product','externalReference']),['clientReference','product','externalReference'],true),
  submit:objectJsonSchema('submit inputs',jsonFields(['clientReference','product','externalReference']),['clientReference','product','externalReference'],true),
  member:objectJsonSchema('member inputs',jsonFields(['clientReference','firstName','lastName','memberActivationDate']),['clientReference','firstName','lastName'],true),
};
/** Serializable descriptive schemas; dynamic input/output bindings are enforced by the worker. */
export function capabilityContractDescription(task:TaskKind){
  return {task,description:taskInputDescriptions[task],inputContractId:'banking-inputs-v1',inputSchema:taskInputJsonSchemas[task],outputContractId:taskOutputContractIds[task],outputSchema:outputJsonSchemas[taskOutputContractIds[task]]};
}

export const accountChoiceSchema=z.object({
  accountReference:z.string().regex(new RegExp(accountReferencePattern)),
  accountNumber:z.string().regex(/^[A-Za-z0-9-]{1,32}$/).optional(),
  product:z.string().trim().min(1).max(120),status:z.string().trim().min(1).max(80),
}).strict();
export type AccountChoice=z.infer<typeof accountChoiceSchema>;
export const accountSelectionSchema=z.object({clientReference:contractFields.clientReference.schema,choices:z.array(accountChoiceSchema).min(1).max(100)}).strict();
export const locatorSchema = z.object({
  kind: z.enum(['role', 'label', 'text', 'css']),
  value: z.string().min(1).max(300),
  role: z.string().max(50).optional(),
  exact: z.boolean().default(true),
  scope: z.string().max(300).optional(),
});
export type TargetLocator = z.infer<typeof locatorSchema>;
export const valueSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), key: z.enum(['clientReference', 'accountReference', 'product', 'externalReference', 'firstName', 'lastName', 'memberActivationDate']) }),
  z.object({ source: z.literal('literal'), value: z.string().max(200) }),
]);
export type ValueRef = z.infer<typeof valueSchema>;
export const stepSchema = z.object({
  id: z.string().min(1), label: z.string().min(1).max(160),
  action: z.enum(['navigate', 'fill', 'click', 'select', 'press', 'checkpoint']),
  target: locatorSchema.optional(), value: valueSchema.optional(), path: z.string().optional(),
  checkpoint: z.enum(['client', 'account', 'preview', 'submitted', 'member_preview', 'member_created', 'member_absent']).optional(),
  effect: z.enum(['read', 'form', 'commit']).default('read'),
});
export type CapabilityStep = z.infer<typeof stepSchema>;
export const capabilitySchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), version: z.enum(['1.0.0','1.1.0']),
  name: z.string().min(1).max(120), description: z.string().max(400), task: taskSchema,
  target: z.enum(['local-banking-lab','mifos-x']),
  inputs: z.literal('banking-inputs-v1'),
  output: z.enum(['balance-v1', 'prepared-v1', 'submitted-v1', 'member-v1']),
  steps: z.array(stepSchema).min(1).max(60),
  provenance: z.object({ kind: z.enum(['authored', 'discovered']), runId: z.string().optional(), provider: z.string().optional(), model: z.string().optional() }),
});
export type Capability = z.infer<typeof capabilitySchema>;
export interface CapabilityQualification {
  eligible: boolean; reasons: string[]; discoveryRunId?: string; replayRunIds: string[];
  distinctMemberCount: number; testedProducts: string[];
  successfulReplays: number; totalReplays: number; digestVerified: boolean;
}
export interface CapabilityApproval {
  at: string; digest: string; discoveryRunId?: string; replayRunIds: string[];
}
export type CapabilityRecord = Capability & {
  digest: string; status: 'approved'|'draft'|'quarantined'; createdAt: string; replayCount: number; successCount: number;
  qualification?: CapabilityQualification; approvalReview?: CapabilityApproval;
};
export type RunStatus = 'queued'|'running'|'pausing'|'awaiting_human'|'human_control'|'awaiting_approval'|'completed';
export type RunResult = 'succeeded'|'business_outcome'|'failed'|'cancelled';
export type ControlOwner = 'automation'|'human'|'none';
export interface RunEvent { id: number; timestamp: string; kind: string; message: string; stepId?: string; actor: 'automation'|'human'|'system'; }
export interface StepState { id: string; label: string; state: 'pending'|'running'|'verified'|'failed'|'waiting'; }
export interface Intervention { reason: string; code: string; createdAt: string; accountSelection?:z.infer<typeof accountSelectionSchema>; }
export interface Approval { id: string; digest: string; summary: Record<string,string>; expiresAt: string; consumed: boolean; }
export interface DiscoveryBudget {
  maxModelCalls:number; maxActions:number; maxActiveMs:number;
  maxUnchangedObservations:number; maxConsecutiveWaits:number;
  actions:number; activeMs:number; unchangedObservations:number; consecutiveWaits:number;
}
export interface Run {
  targetId?: 'local-banking-lab'|'mifos-x';
  id: string; mode: 'replay'|'discovery'; task: TaskKind; goal: string;
  capabilityId?: string; capabilityDigest?: string; status: RunStatus;
  replayPurpose?: 'validation'|'execution';
  result?: RunResult; effect: 'none'|'verified'|'unknown'; outcomeCode?: string;
  /** Intermediate checkpoints may use a record; terminal success must pass its FinalBusinessOutput contract. */
  output?: Record<string,unknown>; inputs: RunInputs; resolvedInputs?: Partial<RunInputs>; scenario: Scenario;
  createdAt: string; updatedAt: string; finishedAt?: string;
  sessionId: string; owner: ControlOwner; epoch: number;
  stepIndex: number; steps: StepState[]; events: RunEvent[];
  intervention?: Intervention; approval?: Approval; error?: string;
  frameRevision: number; frameAt?: string; viewport: {width:number;height:number};
  provider?: string; model?: string; modelCalls: number; discoveredCapabilityId?: string;
  discoveryBudget?: DiscoveryBudget;
}
export const createRunSchema = z.object({
  mode: z.enum(['replay','discovery']).default('replay'),
  replayPurpose: z.enum(['validation','execution']).optional(),
  task: taskSchema.default('balance'), capabilityId: z.string().optional(),
  goal: z.string().min(1).max(1200).optional(),
  goalReviewed: z.boolean().optional(),
  inputs: inputSchema.default({}), scenario: scenarioSchema.default('normal'),
  idempotencyKey: z.string().min(8).max(100),
  provider: z.enum(['openai','anthropic','google']).optional(), model: z.string().max(100).optional(),
});
export type CreateRun = z.infer<typeof createRunSchema>;
export interface GoalResolution {
  status: 'ready'|'clarification'; goal: string; task?: TaskKind;
  inputs?: RunInputs; capabilityId?: string; explanation: string; questions: string[];
  clarificationKind?: 'account_intent'|'new_member';
}
export interface ObservedControl { id: string; role: string; name: string; value?: string; locator: TargetLocator; }
export interface Observation { url: string; title: string; text: string; controls: ObservedControl[]; screenshot?: string; }
export interface DiscoveryProposal {
  action: 'click'|'fill'|'select'|'press'|'wait'|'done'|'ask_human';
  targetId?: string; value?: string; inputKey?: keyof RunInputs; reason: string;
}
export interface ProviderConfig { provider:'openai'|'anthropic'|'google'; model:string; apiKey:string; baseUrl?:string; }
export interface ProviderStatus { id:'openai'|'anthropic'|'google'; configured:boolean; model:string; }
export interface AppState {
  runs: Run[]; capabilities: CapabilityRecord[]; providers: ProviderStatus[];
  target: {id?:'local-banking-lab'|'mifos-x';name:string;url:string;kind:'local';synthetic:true};
  runtime: {mode:'local';dataPath:string;browserAvailable:boolean;browserPath?:string;version:string};
}
export const humanInputSchema = z.object({
  epoch:z.number().int(), frameRevision:z.number().int(), commandId:z.string().min(8).max(100),
  action:z.enum(['click','type','key','scroll']), x:z.number().optional(), y:z.number().optional(),
  text:z.string().max(200).optional(), key:z.string().max(40).optional(), deltaY:z.number().max(2000).min(-2000).optional(),
});
export type HumanInput = z.infer<typeof humanInputSchema>;
export const defaultGoals:Record<TaskKind,string> = {
  balance:'Find the member and read the current savings balance.',
  prepare:'Prepare a savings application and stop at the verified preview.',
  submit:'Prepare a savings application, request approval, and submit it once.',
  member:'Prepare a new member, request approval of the exact preview, and create it once.',
};
