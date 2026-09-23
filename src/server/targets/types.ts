import type { Locator, Page, Request } from 'playwright-core';
import type { AccountChoice, CapabilityRecord, CapabilityStep, RunInputs, Scenario, TargetLocator } from '../../shared/contracts.js';
export type { AccountChoice } from '../../shared/contracts.js';

export class AccountSelectionRequired extends Error {
  constructor(public readonly boundClientReference:string,public readonly choices:AccountChoice[]){
    super(`Member ${boundClientReference} has more than one matching savings account. Choose the account to inspect.`);
    this.name='AccountSelectionRequired';
  }
}
export class TargetBusinessError extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='TargetBusinessError';}
}

export type Checkpoint = 'client' | 'account' | 'preview' | 'submitted' | 'member_preview' | 'member_created' | 'member_absent';
export type TargetState = { kind: 'business' | 'intervention' | 'unknown'; code: string; message: string };
export interface TargetProfile {
  id: 'local-banking-lab' | 'mifos-x';
  name: string;
  baseUrl: string;
  entryPath: string;
  version: string;
  bootstrap(page: Page, scenario: Scenario, assertActive: () => void): Promise<void>;
  /** Wait for the visible result of a dispatched SPA action before observing again. */
  awaitObservationReady?(page: Page, step: CapabilityStep, inputs: RunInputs): Promise<void>;
  resolveInputs?(page: Page, task: import('../../shared/contracts.js').TaskKind, inputs: RunInputs): Promise<Partial<RunInputs>>;
  checkpoint(page: Page, kind: Checkpoint, inputs: RunInputs, resolvedInputs?: Partial<RunInputs>): Promise<Record<string, unknown>>;
  atCheckpoint(page: Page, kind: Checkpoint): Promise<boolean>;
  detectState(page: Page): Promise<TargetState | undefined>;
  isCommitTarget(page: Page, locator: Locator): Promise<boolean>;
  networkPolicy(request: Request): 'read' | 'authentication' | 'commit' | 'deny';
  validateCommit?(request: Request, inputs: RunInputs, summary: Record<string, string>): boolean;
  parameterize(target: TargetLocator, inputs: RunInputs, resolvedInputs?: Partial<RunInputs>): TargetLocator;
  capabilities(): CapabilityRecord[];
  resolveAccount?(page: Page, inputs: RunInputs): Promise<string>;
  listAccountChoices?(page: Page, inputs: RunInputs): Promise<AccountChoice[]>;
  reconcile(page: Page, inputs: RunInputs, task?: import('../../shared/contracts.js').TaskKind): Promise<Record<string, unknown> | undefined>;
}
