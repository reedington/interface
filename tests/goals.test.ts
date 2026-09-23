import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGoal, reviewedGoalProblem, goalExamples } from '../src/server/goals.js';

test('natural-language examples map to explicit safe workflow contracts',()=>{
  const results=goalExamples.map(goal=>resolveGoal(goal));
  assert.deepEqual(results.map(r=>r.status),['ready','ready','ready']);
  assert.deepEqual(results.map(r=>r.task),['balance','prepare','submit']);
  assert.equal(results[0].inputs?.clientReference,'10001');
  assert.equal(results[0].inputs?.accountReference,'');
  assert.equal(results[1].inputs?.clientReference,'10002');
  assert.equal(results[2].capabilityId,'lab-submit-us-v1');
});
test('explicit member/account/product/reference values survive goal review',()=>{
  const balance=resolveGoal('Show the current savings balance for member #10002, account SAV-1002');
  assert.equal(balance.inputs?.accountReference,'SAV-1002');
  const application=resolveGoal('Prepare a Growth Savings application for member ID 10002 with external reference US-123 and stop at preview');
  assert.equal(application.inputs?.product,'Growth Savings');
  assert.equal(application.inputs?.externalReference,'US-123');
  assert.equal(application.task,'prepare');
});
test('an ambiguous account request asks the starting point without guessing identity or authorizing submission',()=>{
  const result=resolveGoal('create an account for me');
  assert.equal(result.status,'clarification');
  assert.equal(result.task,undefined);
  assert.equal(result.inputs,undefined);
  assert.equal(result.capabilityId,undefined);
  assert.match(result.explanation,/not linked to a member/);
  assert.equal(result.clarificationKind,'account_intent');
  assert.match(result.questions.join(' '),/new member\/customer first/);
  assert.match(result.questions.join(' '),/existing member/);
  assert.doesNotMatch(result.questions.join(' '),/balance/);
  const clarified=resolveGoal('Create an Everyday Savings account for member 10001 and stop at review');
  assert.equal(clarified.status,'ready');
  assert.equal(clarified.task,'prepare');
  assert.equal(clarified.inputs?.clientReference,'10001');
  assert.equal(clarified.inputs?.product,'Everyday Savings');
});
test('new member onboarding collects explicit identity and preserves the separate approval boundary',()=>{
  for(const goal of ['Create a new member after my approval','Register a new customer','Register a new member 10001 and prepare a savings application','Create a new member with first name "Jordan" and last name "Ellis"']){
    const result=resolveGoal(goal);assert.equal(result.status,'clarification');assert.equal(result.clarificationKind,'new_member');assert.equal(result.inputs,undefined);
  }
  const goal='Create a new member with first name "Jordan" and last name "Ellis", member reference 170001, after my approval';
  const result=resolveGoal(goal);
  assert.equal(result.status,'ready');assert.equal(result.task,'member');
  assert.equal(result.inputs?.clientReference,'170001');assert.equal(result.inputs?.firstName,'Jordan');assert.equal(result.inputs?.lastName,'Ellis');
  assert.equal(result.inputs?.accountReference,'');assert.equal(reviewedGoalProblem(goal,'member',result.inputs!),undefined);
  assert.match(reviewedGoalProblem(goal,'member',{...result.inputs!,lastName:'Other'})!,/lastName/);
  assert.equal(resolveGoal('Do not create a new member with first name "Jordan" and last name "Ellis", member reference 170001').status,'clarification');
});
test('missing, ambiguous, combined and unsupported requests ask for clarification',()=>{
  for(const goal of [
    'Read the savings balance',
    'Look up member 10001 and member 10002 and read their savings balance',
    'Open a sub-account for member 10001 and reach confirmation',
    'Read member 10001 balance and submit a savings application',
    'Submit a savings application for member 10001 and stop at review',
    'Transfer money from member 10001 and read the balance',
    'Read the available savings balance for member 10001',
    'Download all statements for member 10001',
    'Read the savings balance for member 10001 or 10002',
    'Read the balance for member 10001, account 99999',
    'Prepare a Premium Savings application for member 10001',
    'Read the Growth Savings balance for member 10001',
    'Read member 10001 savings balance in EUR',
    'Do not read member 10001 savings balance',
  ])assert.equal(resolveGoal(goal).status,'clarification',goal);
});
test('negated submission never becomes commit permission and edited plans cannot contradict goals',()=>{
  const result=resolveGoal('Prepare an application for member 10001, do not submit');
  assert.equal(result.task,'prepare');
  assert.equal(reviewedGoalProblem(result.goal,'prepare',result.inputs!),undefined);
  assert.match(reviewedGoalProblem(result.goal,'submit',result.inputs!)!,/conflicts/);
  assert.match(reviewedGoalProblem(result.goal,'prepare',{...result.inputs!,clientReference:'10002'})!,/member reference/);
});

test('reviewed member identity ignores unrelated savings defaults',()=>{
  const goal='Create a new member with first name "Jordan" and last name "Ellis", member reference 170001';
  const result=resolveGoal(goal);assert.equal(result.status,'ready');
  assert.equal(reviewedGoalProblem(goal,'member',{...result.inputs!,externalReference:'UNUSED-SAVINGS-REF',product:'Growth Savings',accountReference:'SAV-9999'}),undefined);
  assert.match(reviewedGoalProblem(goal,'member',{...result.inputs!,clientReference:'170002'})!,/member reference/);
});
