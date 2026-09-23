import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { createRunSchema, humanInputSchema, capabilityContractDescription, type AppState } from '../shared/contracts.js';
import { Store } from './store.js';
import { Engine, ActionError } from './engine.js';
import { startTarget } from './target.js';
import { browserPath } from './surface.js';
import { configureProvider, getProviderStatuses } from './providers.js';
import { resolveGoal } from './goals.js';
import { qualifyCapability } from './qualification.js';
import { createMifosProfile } from './targets/mifos.js';
import { createLabProfile } from './targets/lab.js';
import type { TargetProfile } from './targets/types.js';
import { acquireWorkerLock } from './worker-lock.js';
import { redactRun } from './privacy.js';

export async function startWorkbench(options:{port?:number;targetPort?:number;dataPath?:string;target?:'lab'|'mifos';profile?:TargetProfile}={}) {
  const port=options.port??Number(process.env.WORKBENCH_PORT||4317);
  const targetPort=options.targetPort??Number(process.env.TARGET_PORT||4318);
  const dataPath=resolve(options.dataPath||process.env.WORKBENCH_DATA_DIR||'.local/data');
  let target:Awaited<ReturnType<typeof startTarget>>|undefined;
  let profile=options.profile;
  if(!profile&&options.target==='mifos'){
    const fixturePath=resolve(process.env.MIFOS_FIXTURE_DIR||'.local/mifos','fixtures.json');
    if(!existsSync(fixturePath))throw new Error('Mifos test fixtures are missing. Run npm run setup first.');
    const fixtures=z.object({origin:z.string().url(),composeProject:z.string().optional(),tenant:z.literal('default'),officeId:z.number().int().positive().optional(),productIds:z.object({'Everyday Savings':z.number().int().positive(),'Growth Savings':z.number().int().positive()})}).parse(JSON.parse(readFileSync(fixturePath,'utf8')));
    const baseUrl=new URL(process.env.MIFOS_URL||'http://127.0.0.1:4200').origin;
    if(fixtures.origin!==baseUrl||(process.env.MIFOS_TENANT||'default')!==fixtures.tenant)throw new Error('Mifos fixture origin or tenant changed. Run npm run setup for the configured local stack.');
    const project=process.env.MIFOS_COMPOSE_PROJECT||'interface-mifos';
    if((fixtures.composeProject||'interface-mifos')!==project)throw new Error('Mifos fixture project changed. Run setup for the configured isolated stack.');
    profile=createMifosProfile({baseUrl,username:process.env.MIFOS_USERNAME,password:process.env.MIFOS_PASSWORD,productIds:fixtures.productIds,officeId:fixtures.officeId});
  }
  // Validate Mifos configuration above before taking ownership. The mutex must
  // precede Store: opening Store recovers unfinished history as session-lost.
  const workerLock=acquireWorkerLock(dataPath);
  let openedStore:Store|undefined,openedEngine:Engine|undefined;
  let openedApp:Pick<ReturnType<typeof Fastify>,'close'>|undefined;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    try{
      try{await openedApp?.close();}
      finally{try{if(openedEngine)await openedEngine.close();else openedStore?.close();}finally{await target?.close();}}
    }finally{workerLock.release();}
  })();
  try{
  if(!profile){target=await startTarget(targetPort,dataPath);profile=createLabProfile(target.url);}
  const activeProfile=profile;
  const store=openedStore=new Store(dataPath),engine=openedEngine=new Engine(store,activeProfile);
  for(const capability of activeProfile.capabilities())if(!store.capability(capability.id))store.saveCapability(capability);
  const withQualification=(capability:ReturnType<Store['capabilities']>[number])=>({...capability,qualification:qualifyCapability(capability,capability.provenance.runId?store.run(capability.provenance.runId):undefined,store.capabilityRuns(capability.id))});
  const app=Fastify({logger:false,bodyLimit:32*1024});openedApp=app;
  const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  app.addHook('onRequest',async(req,reply)=>{
    if(!allowedHosts.has(req.headers.host||''))return reply.code(403).send({error:'Unrecognized local host.'});
    const origin=req.headers.origin;
    if(origin&&!allowedHosts.has(origin.replace(/^http:\/\//,'')))return reply.code(403).send({error:'Cross-origin access is not permitted.'});
    if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))return reply.code(415).send({error:'JSON content is required.'});
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((error,req,reply)=>{
    const status=error instanceof ZodError?400:error instanceof ActionError?error.statusCode:500;
    const message=error instanceof ZodError?'Invalid request: '+error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(';'):error instanceof Error?error.message:'The local worker encountered an error.';
    reply.code(status).send({error:message});
  });
  app.get('/api/state',async():Promise<AppState>=>({runs:[...engine.runs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),capabilities:store.capabilities().filter(c=>c.target===activeProfile.id).map(withQualification),providers:getProviderStatuses(),target:{id:activeProfile.id,name:activeProfile.name,url:activeProfile.baseUrl,kind:'local',synthetic:true},runtime:{mode:'local',dataPath,browserAvailable:!!browserPath(),browserPath:browserPath(),version:'0.5.0'}}));
  app.post('/api/goals/resolve',async req=>{const result=resolveGoal(z.object({goal:z.string().trim().min(1).max(1200)}).parse(req.body).goal);if(activeProfile.id!=='mifos-x'&&(result.task==='member'||result.clarificationKind==='new_member'))return {status:'clarification',goal:result.goal,explanation:'New member creation is available in the local Mifos target.',questions:['Open the Mifos workbench to create a member; the separate lab supports existing-member savings workflows.']};if(result.status==='ready')result.capabilityId=activeProfile.capabilities().find(c=>c.task===result.task)?.id;return result;});
  app.post('/api/runs',async req=>engine.create(createRunSchema.parse(req.body)));
  app.get<{Params:{id:string}}>('/api/runs/:id',async req=>engine.get(req.params.id));
  app.get<{Params:{id:string}}>('/api/runs/:id/audit',async(req,reply)=>{const run=engine.get(req.params.id);reply.header('Content-Disposition',`attachment; filename="${encodeURIComponent(run.id)}-audit.json"`);return redactRun(run);});
  app.get<{Params:{id:string}}>('/api/runs/:id/frame',async req=>engine.frame(req.params.id));
  app.post<{Params:{id:string}}>('/api/runs/:id/select-account',async req=>engine.selectAccount(req.params.id,z.object({epoch:z.number().int().positive(),accountReference:z.string().regex(/^[A-Za-z0-9-]{3,32}$/)}).strict().parse(req.body)));
  for(const action of ['pause','takeover','resume','stop','approve','reconcile'])app.post<{Params:{id:string};Body:{epoch?:number;approvalId?:string}}>(`/api/runs/:id/${action}`,async req=>engine.control(req.params.id,action,req.body||{}));
  app.post<{Params:{id:string}}>('/api/runs/:id/input',async req=>engine.humanInput(req.params.id,humanInputSchema.parse(req.body)));
  app.get<{Params:{id:string}}>('/api/capabilities/:id',async req=>{const c=store.capability(req.params.id);if(!c||c.target!==activeProfile.id)throw new ActionError('Capability not found for this application.',404);return {...withQualification(c),contract:capabilityContractDescription(c.task)};});
  app.post<{Params:{id:string}}>('/api/capabilities/:id/approve',async req=>{
    const c=store.capability(req.params.id);if(!c||c.target!==activeProfile.id)throw new ActionError('Capability not found for this application.',404);
    const {expectedDigest}=z.object({expectedDigest:z.string().min(1)}).parse(req.body);
    if(expectedDigest!==c.digest)throw new ActionError('The capability changed since review. Refresh its contract and evidence.');
    if(c.status==='quarantined')throw new ActionError('This capability targets a previous application version and cannot be reapproved. Discover or validate a current version.');
    const qualification=withQualification(c).qualification;
    if(!qualification.eligible)throw new ActionError(qualification.reasons.join(' '));
    if(c.status==='approved')return withQualification(c);
    c.status='approved';c.approvalReview={at:new Date().toISOString(),digest:c.digest,discoveryRunId:qualification.discoveryRunId,replayRunIds:qualification.replayRunIds};store.saveCapability(c);return withQualification(c);
  });
  app.post('/api/providers',async req=>{configureProvider(req.body as Parameters<typeof configureProvider>[0]);return {providers:getProviderStatuses()};});
  const uiPath=resolve('dist/ui');
  if(existsSync(uiPath))await app.register(fastifyStatic,{root:uiPath,index:'index.html'});
  else app.get('/',async(_,reply)=>reply.type('text/plain').send('Build the interface with npm run build, then restart.'));
  await app.listen({host:'127.0.0.1',port});
  return {app,engine,store,url:`http://127.0.0.1:${port}`,targetUrl:activeProfile.baseUrl,close};
  }catch(error){await close().catch(()=>{});throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  startWorkbench({target:process.env.INTERFACE_TARGET==='lab'?'lab':'mifos'}).then(server=>{
    console.log(`Interface is ready at ${server.url}\nLocal banking target: ${server.targetUrl}\nAll browser sessions and replay data stay on this laptop.`);
    let closing=false;const close=async()=>{if(closing)return;closing=true;await server.close();process.exit(0);};
    process.on('SIGINT',close);process.on('SIGTERM',close);
  }).catch(e=>{console.error(`Unable to start Interface: ${e.message}`);process.exit(1);});
}
