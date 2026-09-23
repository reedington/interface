import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { capabilityContractDescription, capabilitySchema, type CapabilityRecord, type Run } from '../src/shared/contracts.js';
import { digest } from '../src/server/capabilities.js';
import { qualifyCapability } from '../src/server/qualification.js';
import { validateFinalOutput, validateTaskInputs } from '../src/server/output-contracts.js';
import { openPrivate, readStateKey, redactRun, redactSecrets } from '../src/server/privacy.js';

export interface ExportSelection { capability:CapabilityRecord; discovery:Run; replay:Run; failure?:Run; }
export interface ExportOptions { dataPath:string; discoveryId:string; replayId:string; failureId?:string; outPath:string; synthetic:true; }
const usage=`Export explicitly selected fictional assessment evidence without starting a worker.
node --import tsx scripts/export-evidence.ts --data <isolated-data-directory> --discovery <run-id> --replay <run-id> --out <new-output-directory> --synthetic [--failure <run-id>]

--synthetic confirms the selected source records contain fictional test data only.
This is an allowlisted assessment export, not a general-purpose PII anonymizer.
The original capability digest is preserved; raw goals, approval tokens, screenshots,
provider bodies and arbitrary event text are omitted. Existing output directories
are never overwritten. No model requests or business actions are performed.`;

export function parseExportArgs(args:string[]):ExportOptions|{help:true}{
  if(args.length===1&&args[0]==='--help')return {help:true};
  const values=new Map<string,string>();let synthetic=false;
  for(let index=0;index<args.length;index++){
    const key=args[index];
    if(key==='--synthetic'){if(synthetic)throw new Error('Duplicate --synthetic flag.');synthetic=true;continue;}
    if(!['--data','--discovery','--replay','--failure','--out'].includes(key))throw new Error('Unsupported export option. Use --help.');
    if(values.has(key))throw new Error(`Duplicate ${key} option.`);
    const value=args[++index];if(!value||value.startsWith('--'))throw new Error(`Missing ${key} value.`);
    values.set(key,value);
  }
  for(const key of ['--data','--discovery','--replay','--out'])if(!values.has(key))throw new Error(`Required export option: ${key}.`);
  if(!synthetic)throw new Error('Export requires --synthetic and an isolated fictional dataset.');
  const discoveryId=values.get('--discovery')!,replayId=values.get('--replay')!,failureId=values.get('--failure');
  for(const id of [discoveryId,replayId,failureId].filter(Boolean))if(!/^[A-Za-z0-9-]{1,100}$/.test(id!))throw new Error('Run IDs must be bounded alphanumeric identifiers.');
  if(discoveryId===replayId||failureId===discoveryId||failureId===replayId)throw new Error('Discovery, replay and optional failure must be different runs.');
  return {dataPath:resolve(values.get('--data')!),outPath:resolve(values.get('--out')!),discoveryId,replayId,failureId,synthetic:true};
}

function assertNoCredentialText(value:unknown){
  const serialized=JSON.stringify(value);
  if(redactSecrets(serialized)!==serialized||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized)){
    throw new Error('Export rejected credential-like content. No evidence was written; inspect the selected fixture locally.');
  }
}
function typedFixture(run:Run){
  const output=validateFinalOutput({task:run.task,targetId:run.targetId,inputs:run.inputs,resolvedInputs:run.resolvedInputs,output:run.output});
  const {previewText: _preview,...publicOutput}=output as Record<string,unknown>;
  return {runId:run.id,inputs:validateTaskInputs(run.task,run.inputs),resolvedInputs:run.task==='balance'?{accountReference:run.resolvedInputs?.accountReference}:run.task==='member'?{memberActivationDate:run.resolvedInputs?.memberActivationDate}:{},output:publicOutput};
}

/** Build from selected, verified records only. Tests use explicitly fabricated history, never live-evidence claims. */
export function buildEvidenceBundle(selection:ExportSelection){
  const {capability,discovery,replay,failure}=selection;
  const parsedArtifact=capabilitySchema.safeParse(capability);
  if(!parsedArtifact.success)throw new Error('The selected capability has an invalid structure; export stopped.');
  const artifact=parsedArtifact.data;
  if(digest(artifact)!==capability.digest)throw new Error('Artifact digest mismatch; export stopped.');
  const qualification=qualifyCapability(capability,discovery,[replay]);
  if(!qualification.eligible)throw new Error('Selected discovery and replay do not qualify this exact capability.');
  if(discovery.id===replay.id)throw new Error('Discovery and replay must be separate runs.');
  const fixtures={dataClassification:'fictional-test-data-only',discovery:typedFixture(discovery),replay:typedFixture(replay)};
  // Refuse rather than rewrite a sensitive literal in an immutable artifact.
  // Parameterization must have removed identity values from the saved contract.
  const artifactText=JSON.stringify(artifact);
  for(const run of [discovery,replay])for(const field of ['clientReference','accountReference','externalReference','firstName','lastName'] as const){
    const value=run.inputs[field];
    if(value&&value.length>=4&&artifactText.includes(value))throw new Error(`Artifact contains an invocation-specific ${field} literal; export stopped without changing its digest.`);
  }
  const publicLog=(run:Run)=>({
    ...redactRun(run),artifactFile:'artifact.json',artifactDigest:capability.digest,
    executedSteps:run.steps.map(step=>{
      const contract=artifact.steps.find(item=>item.id===step.id);
      return {id:step.id,state:step.state,...(contract?{action:contract.action,effect:contract.effect,purpose:contract.label,...(contract.checkpoint?{checkpoint:contract.checkpoint}:{})}:{contractMatch:false})};
    }),
  });
  const source=publicLog(discovery),replayed=publicLog(replay);
  if(failure){
    if((failure.targetId||'local-banking-lab')!==capability.target||failure.result==='succeeded'||!['completed','awaiting_human'].includes(failure.status))throw new Error('Optional failure must be a stopped non-success run against the same target.');
    if(failure.mode!=='replay'||failure.capabilityId!==capability.id||failure.capabilityDigest!==capability.digest)throw new Error('Optional failure must replay this exact artifact.');
  }
  const files:Record<string,unknown>={
    'artifact.json':{...artifact,digest:capability.digest},
    'contract-schemas.json':capabilityContractDescription(capability.task),
    'discovery.json':source,'replay.json':replayed,'fictional-fixtures.json':fixtures,
    ...(failure?{'failure.json':publicLog(failure)}:{}),
    'manifest.json':{schemaVersion:1,exportedAt:new Date().toISOString(),target:capability.target,task:capability.task,artifactId:capability.id,artifactDigest:capability.digest,artifactStatus:capability.status,discoveryRunId:discovery.id,replayRunId:replay.id,...(failure?{failureRunId:failure.id}:{}),provider:discovery.provider,model:discovery.model,discoveryModelCalls:discovery.modelCalls,replayModelCalls:replay.modelCalls,qualification,
      evidencePolicy:'Explicit fictional fixtures; allowlisted redacted audit logs; unchanged capability core/digest; no raw screenshots, goals, approval tokens or provider bodies.',
      limits:['Successful local case evidence, not a multi-run reliability benchmark.','A qualified draft is not automatically approved for unattended use.','No business action, provider request or history recovery is performed by this export.']},
  };
  for(const value of Object.values(files))assertNoCredentialText(value);
  return files;
}

/** Never construct Store here: its normal startup path recovers unfinished runs. */
export async function readEvidenceSelection(options:ExportOptions):Promise<ExportSelection>{
  if(!options.synthetic)throw new Error('Only explicitly fictional records can be read for export.');
  const db=new DatabaseSync(join(options.dataPath,'workbench.sqlite'),{readOnly:true});
  try{
    let key:Buffer|undefined;
    const record=<T extends {id:string}>(table:'runs'|'capabilities',id:string):T=>{
      const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as {id:string;body:string;private_state?:string|null}|undefined;
      if(!row)throw new Error('A selected record does not exist in the specified history.');
      const serialized=row.private_state?openPrivate(row.private_state,key??=readStateKey(options.dataPath),`${table}:${row.id}`):row.body;
      let value:T;try{value=JSON.parse(serialized);}catch{throw new Error('A selected history record is invalid JSON; no raw record was printed.');}
      if(value.id!==id)throw new Error('Selected record identity does not match its storage key.');
      return value;
    };
    const discovery=record<Run>('runs',options.discoveryId),replay=record<Run>('runs',options.replayId);
    if(!discovery.discoveredCapabilityId)throw new Error('Selected discovery did not publish a capability.');
    return {capability:record<CapabilityRecord>('capabilities',discovery.discoveredCapabilityId),discovery,replay,...(options.failureId?{failure:record<Run>('runs',options.failureId)}:{})};
  }finally{db.close();}
}

const failureStateSchema=z.object({
  policy:z.literal('geometry-only-v1'),outcomeCode:z.string().regex(/^[A-Z_]{1,80}$/).optional(),intervention:z.string().regex(/^[A-Z_]{1,80}$/).optional(),stepIndex:z.number().int().nonnegative(),
  structure:z.object({title:z.literal('[redacted]'),controls:z.array(z.object({
    tag:z.enum(['button','input','select','textarea','table','div','section']),
    type:z.enum(['button','submit','reset','text','password','search','email','number','tel','url','date','datetime-local','time','month','week','checkbox','radio','range','color','file','hidden','image']).optional(),disabled:z.boolean(),
  }).strict()).max(200)}).strict(),
}).strict();

export async function exportEvidence(options:ExportOptions){
  if(!options.synthetic)throw new Error('Only explicitly fictional records can be exported.');
  const files=buildEvidenceBundle(await readEvidenceSelection(options));
  if(options.failureId){
    // Export the safe structural snapshot rather than trusting an old JPEG to
    // have been redacted. Legacy raw-image evidence is never copied implicitly.
    let snapshot:unknown;
    try{snapshot=JSON.parse(await readFile(join(options.dataPath,'evidence',`${options.failureId}.json`),'utf8'));}
    catch{throw new Error('The selected failure has no readable sanitized structural snapshot.');}
    const parsed=failureStateSchema.safeParse(snapshot);
    if(!parsed.success)throw new Error('Failure snapshot does not match the sanitized structural evidence policy; no raw snapshot was printed.');
    files['failure-state.json']={runId:options.failureId,...parsed.data};
  }
  // Validate everything before creating the output directory. Never overwrite an
  // earlier evidence package or touch the source database/worker lifecycle.
  await mkdir(options.outPath,{recursive:false,mode:0o755});
  for(const [name,value] of Object.entries(files))await writeFile(join(options.outPath,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o644});
  return {path:options.outPath,files:Object.keys(files)};
}
async function main(){
  const options=parseExportArgs(process.argv.slice(2));
  if('help' in options){console.log(usage);return;}
  const result=await exportEvidence(options);console.log(`Exported ${result.files.length} reviewed evidence files to ${result.path}. No live services were called.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){await main();}
