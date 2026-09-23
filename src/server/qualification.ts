import { capabilitySchema, type CapabilityQualification, type CapabilityRecord, type Run } from '../shared/contracts.js';
import { digest } from './capabilities.js';

/** Review is derived from durable evidence, never a mutable success counter. */
export function qualifyCapability(capability: CapabilityRecord, source: Run | undefined, history: Run[]): CapabilityQualification {
  const parsed = capabilitySchema.safeParse(capability);
  const digestVerified = parsed.success && digest(parsed.data) === capability.digest;
  const reasons: string[] = [];
  if (!digestVerified) reasons.push('The capability content does not match its recorded digest.');
  if (capability.status === 'quarantined') reasons.push('This capability is quarantined and cannot be approved.');
  if (capability.provenance.kind !== 'discovered') reasons.push('Authored baselines are not model-discovered qualification evidence.');
  const isSource = !!source && capability.provenance.kind === 'discovered'
    && source.id === capability.provenance.runId && source.mode === 'discovery'
    && (source.targetId || 'local-banking-lab') === capability.target
    && source.task === capability.task && source.status === 'completed' && source.result === 'succeeded'
    && source.outcomeCode === 'DISCOVERED' && source.discoveredCapabilityId === capability.id
    && (!['submit','member'].includes(capability.task) || source.effect === 'verified')
    && source.modelCalls > 0 && source.provider === capability.provenance.provider
    && source.model === capability.provenance.model && !hasManualRepair(source);
  if (capability.provenance.kind === 'discovered' && !isSource) {
    reasons.push('A successful, unassisted source discovery must be available in local history.');
  }
  const replays = history.filter(run => run.capabilityId === capability.id && run.capabilityDigest === capability.digest && run.mode === 'replay' && (run.targetId || 'local-banking-lab') === capability.target);
  const successful = replays.filter(run => run.task === capability.task && run.status === 'completed'
    && run.result === 'succeeded' && run.outcomeCode === 'VERIFIED' && run.modelCalls === 0
    && !hasManualRepair(run) && (!['submit','member'].includes(capability.task) || run.effect === 'verified'));
  const qualifying = isSource ? successful.filter(run => differentInputs(source!, run)) : [];
  if (capability.provenance.kind === 'discovered' && qualifying.length === 0) {
    reasons.push(capability.task === 'member' ? 'Validate this exact capability with a different new member reference and name, with zero model calls, no manual repair, and a separate creation approval.' : capability.task === 'balance'
      ? 'Validate this exact capability with a different member and savings account, with zero model calls and no manual repair.'
      : 'Validate this exact capability with a different member and a fresh external reference, with zero model calls and no manual repair. Submission approval is still required.');
  }
  const demonstrated = isSource ? [source!, ...qualifying] : [];
  return {
    eligible: reasons.length === 0, reasons, digestVerified,
    ...(isSource ? { discoveryRunId: source!.id } : {}),
    replayRunIds: qualifying.map(run => run.id),
    successfulReplays: successful.length, totalReplays: replays.length,
    distinctMemberCount: new Set(demonstrated.map(run => run.inputs.clientReference)).size,
    testedProducts: ['balance','member'].includes(capability.task) ? [] : [...new Set(demonstrated.map(run => run.inputs.product))],
  };
}

function hasManualRepair(run: Run): boolean {
  return run.events.some(event => ['manual', 'recovery', 'reconcile'].includes(event.kind));
}

function differentInputs(source: Run, replay: Run): boolean {
  if (source.inputs.clientReference === replay.inputs.clientReference) return false;
  if(source.task==='member')return !!replay.inputs.firstName&&!!replay.inputs.lastName&&(source.inputs.firstName!==replay.inputs.firstName||source.inputs.lastName!==replay.inputs.lastName);
  if (source.task === 'balance') {
    const account = (run: Run) => run.inputs.accountReference || run.resolvedInputs?.accountReference;
    return !!account(source) && !!account(replay) && account(source) !== account(replay);
  }
  return !!replay.inputs.externalReference && source.inputs.externalReference !== replay.inputs.externalReference;
}
