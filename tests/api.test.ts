import { describe, expect, it } from 'vitest';

import { createApiHandler, type ApiRequest, type ApiResponse } from '../src/api/handler.js';
import { createPracticeGate, type Judge } from '../src/practices/enact.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';

const AMPLE_BOUND = 100_000;

const ONE_PRACTICE = JSON.stringify({
 version: 1,
 practices: [
 {
 id: 'no-anonymous-path',
 title: 'No anonymous path',
 body: 'Only a present credential yields headers.',
 },
 ],
});

function readerReturning(result: ReadResult): SourceReader {
 return () => Promise.resolve(result);
}

function allow(): Judge {
 return () => Promise.resolve({ allow: true });
}

function refuseWith(reason: string): Judge {
 return () => Promise.resolve({ allow: false, reason });
}

function handlerFor(result: ReadResult, judge: Judge = allow()) {
 const gate = createPracticeGate('s', readerReturning(result), AMPLE_BOUND);
 return createApiHandler(gate, judge);
}

describe('createApiHandler', () => {
 describe('every route', () => {
 it('provision: returns exactly what the gate returns for a matching query', async () => {
 const handle = handlerFor({ kind: 'text', text: ONE_PRACTICE });
 const response = await handle({
 route: 'provision',
 conversationId: 'conv-1',
 query: 'no-anonymous-path',
 });
 expect(response).toEqual({
 kind: 'practices',
 practices: [
 {
 id: 'no-anonymous-path',
 title: 'No anonymous path',
 body: 'Only a present credential yields headers.',
 },
 ],
 });
 });

 it('enact: returns exactly what the gate returns when the judge allows', async () => {
 const handle = handlerFor({ kind: 'text', text: ONE_PRACTICE }, allow());
 const response = await handle({
 route: 'enact',
 conversationId: 'conv-1',
 capability: 'no-anonymous-path',
 });
 expect(response).toEqual({
 kind: 'enacted',
 consulted: {
 source: 's',
 query: 'no-anonymous-path',
 practiceIds: ['no-anonymous-path'],
 },
 });
 });
 });

 describe('the conversation id', () => {
 it('refuses a provision request with no conversation id, and never reaches the reader', async () => {
 let reads = 0;
 const counting: SourceReader = () => {
 reads += 1;
 return Promise.resolve({ kind: 'text', text: ONE_PRACTICE });
 };
 const gate = createPracticeGate('s', counting, AMPLE_BOUND);
 const handle = createApiHandler(gate, allow());

 const response = await handle({
 route: 'provision',
 conversationId: '',
 query: 'no-anonymous-path',
 });

 expect(response).toEqual({
 kind: 'rejected',
 reason:
 'conversationId is required on every request — without it, spend and ' +
 'enactment cannot be attributed back to the work that caused them',
 });
 // Reaches the specific path it names: the id check runs before the
 // reader is ever touched, not merely before the response is shaped.
 expect(reads).toBe(0);
 });

 it('refuses an enact request with a whitespace-only conversation id, and never calls the judge', async () => {
 let judgeCalls = 0;
 const judge: Judge = () => {
 judgeCalls += 1;
 return Promise.resolve({ allow: true });
 };
 const gate = createPracticeGate(
 's',
 readerReturning({ kind: 'text', text: ONE_PRACTICE }),
 AMPLE_BOUND,
 );
 const handle = createApiHandler(gate, judge);

 const response = await handle({
 route: 'enact',
 conversationId: '   ',
 capability: 'no-anonymous-path',
 });

 expect(response.kind).toBe('rejected');
 expect(judgeCalls).toBe(0);
 });

 it('a request missing the field entirely is rejected, not answered with an invented id', async () => {
 // The regression this guards: an invented id is worse than a refusal,
 // because it attributes the call to a conversation that never made
 // it. Checked as the exact rejected shape rather than "some id is
 // present", which a stub id would also satisfy.
 let reads = 0;
 const counting: SourceReader = () => {
 reads += 1;
 return Promise.resolve({ kind: 'text', text: ONE_PRACTICE });
 };
 const gate = createPracticeGate('s', counting, AMPLE_BOUND);
 const handle = createApiHandler(gate, allow());
 const malformed = { route: 'provision', query: 'no-anonymous-path' } as unknown as ApiRequest;

 const response = await handle(malformed);

 expect(response).toEqual({
 kind: 'rejected',
 reason:
 'conversationId is required on every request — without it, spend and ' +
 'enactment cannot be attributed back to the work that caused them',
 });
 expect(reads).toBe(0);
 });
 });

 describe('the three outcomes stay distinct through the API boundary', () => {
 it('an unreachable bar arrives as could-not-consult, never flattened to refused', async () => {
 // The judge would have refused if it were ever asked — it is not
 // asked, and the response says why in a kind a caller cannot mistake
 // for a judge's decision.
 const handle = handlerFor(
 { kind: 'unreachable', reason: 'ECONNREFUSED' },
 refuseWith('would have refused anyway'),
 );

 const response = await handle({
 route: 'enact',
 conversationId: 'conv-1',
 capability: 'anything',
 });

 expect(response).toEqual({
 kind: 'could-not-consult',
 why: 'unreachable',
 reason: 'ECONNREFUSED',
 consulted: { source: 's', query: 'anything', practiceIds: [] },
 });
 });

 it('a judge refusal arrives as refused, distinct from could-not-consult, when the bar WAS read', async () => {
 const handle = handlerFor(
 { kind: 'text', text: ONE_PRACTICE },
 refuseWith('does not satisfy the rule'),
 );

 const response = await handle({
 route: 'enact',
 conversationId: 'conv-1',
 capability: 'no-anonymous-path',
 });

 expect(response).toEqual({
 kind: 'refused',
 reason: 'does not satisfy the rule',
 consulted: {
 source: 's',
 query: 'no-anonymous-path',
 practiceIds: ['no-anonymous-path'],
 },
 });
 });

 it('a malformed enact request is rejected, distinct from both refused and could-not-consult', async () => {
 // Reader would report unreachable if reached; capability is blank,
 // so this must be caught before the gate is asked anything at all.
 const handle = handlerFor({ kind: 'unreachable', reason: 'ECONNREFUSED' });

 const response = await handle({
 route: 'enact',
 conversationId: 'conv-1',
 capability: '   ',
 });

 expect(response).toEqual({ kind: 'rejected', reason: 'capability is required' });
 });

 it('provision: an unavailable corpus arrives as unavailable, distinct from nothing-matched', async () => {
 const handle = handlerFor({ kind: 'missing', reason: 'HTTP 404' });

 const response = await handle({
 route: 'provision',
 conversationId: 'conv-1',
 query: 'anything',
 });

 expect(response).toEqual({
 kind: 'unavailable',
 source: 's',
 why: 'missing',
 reason: 'HTTP 404',
 });
 });
 });

 // Pins the composition itself: the same handler function works with no
 // server, no framework and no process boundary anywhere in the call —
 // driven directly with a plain request object and read back as a plain
 // response object, exactly as "two composition roots, one handler"
 // requires.
 it('works with no server at all — driven directly with a request shape', async () => {
 const gate = createPracticeGate(
 's',
 readerReturning({ kind: 'text', text: ONE_PRACTICE }),
 AMPLE_BOUND,
 );
 const handle = createApiHandler(gate, allow());
 expect(typeof handle).toBe('function');

 const request: ApiRequest = {
 route: 'provision',
 conversationId: 'conv-42',
 query: 'no-anonymous-path',
 };
 const response: ApiResponse = await handle(request);

 expect(response).toEqual({
 kind: 'practices',
 practices: [
 {
 id: 'no-anonymous-path',
 title: 'No anonymous path',
 body: 'Only a present credential yields headers.',
 },
 ],
 });
 });
});
