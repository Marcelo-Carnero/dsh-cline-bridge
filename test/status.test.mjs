import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStatus,
  lastTurnEnd,
  foldPendingMessages,
  undecidedApprovals,
  openAskUserQuestions,
} from '../lib/status.js';

function ev(seq, type, data = {}) {
  return { seq, time: 1000 + seq, type, data };
}

describe('deriveStatus', () => {
  it('waiting states win over everything', () => {
    assert.equal(deriveStatus({ pendingApprovals: 1, pendingQuestions: 0, events: [] }), 'waiting_for_approval');
    assert.equal(deriveStatus({ pendingApprovals: 0, pendingQuestions: 2, events: [] }), 'waiting_for_user');
  });

  it('running agent wins over closed turns', () => {
    const events = [ev(0, 'turn/start', { turn: 1 }), ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
    assert.equal(deriveStatus({ agentStatus: 'running', pendingApprovals: 0, pendingQuestions: 0, events }), 'running');
    assert.equal(deriveStatus({ agentStatus: 'idle', pendingApprovals: 0, pendingQuestions: 0, events }), 'completed');
  });

  it('queued when inbox has work', () => {
    assert.equal(deriveStatus({ hasPendingInbox: true, pendingApprovals: 0, pendingQuestions: 0, events: [] }), 'queued');
  });

  it('maps terminal reasons', () => {
    const end = (kind) => [ev(0, 'turn/start', { turn: 1 }), ev(1, 'turn/end', { turn: 1, reason: { kind } })];
    const base = { agentStatus: 'idle', pendingApprovals: 0, pendingQuestions: 0 };
    assert.equal(deriveStatus({ ...base, events: end('error') }), 'failed');
    assert.equal(deriveStatus({ ...base, events: end('aborted') }), 'cancelled');
    assert.equal(deriveStatus({ ...base, events: end('blocked') }), 'blocked');
    assert.equal(deriveStatus({ ...base, events: end('max-tokens') }), 'max-tokens');
    assert.equal(deriveStatus({ ...base, events: [{ ...ev(0, 'user/message', {}), data: { content: [] } }], live: true }), 'idle');
    assert.equal(deriveStatus({ ...base, events: [], live: false }), 'unknown');
  });

  it('lastTurnEnd finds the tail turn', () => {
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev(2, 'turn/start', { turn: 2 }),
    ];
    assert.equal(lastTurnEnd(events), undefined);
    assert.deepEqual(lastTurnEnd(events.slice(0, 2)), { turn: 1, reason: { kind: 'completed' } });
  });
});

describe('foldPendingMessages', () => {
  it('replays splice semantics', () => {
    const events = [
      ev(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'm1' }] }),
      ev(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ id: 's1' }, { id: 's2' }] }),
      ev(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ];
    assert.deepEqual(foldPendingMessages(events), { nextTurn: 1, nextStep: 1 });
  });
});

describe('undecidedApprovals / openAskUserQuestions', () => {
  it('pairs asked with decided', () => {
    const events = [
      ev(0, 'approval/asked', { id: 'a1', toolName: 'bash' }),
      ev(1, 'approval/asked', { id: 'a2', toolName: 'read' }),
      ev(2, 'approval/decided', { id: 'a1' }),
    ];
    const open = undecidedApprovals(events);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, 'a2');
  });

  it('tracks ask_user_question calls to their results', () => {
    const events = [
      ev(0, 'tool/call', { name: 'ask_user_question', callId: 'c1', arguments: '{}' }),
      ev(1, 'tool/call', { name: 'bash', callId: 'c2', arguments: '{}' }),
      ev(2, 'tool/result', { message: { source: { callId: 'c1' } } }),
    ];
    assert.deepEqual(openAskUserQuestions(events), []);
    const events2 = events.slice(0, 2);
    assert.equal(openAskUserQuestions(events2).length, 1);
  });
});
