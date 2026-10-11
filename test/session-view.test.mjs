import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastTurnSpan,
  assistantTextForTurn,
  toolCallsForTurn,
  changedFilesForTurn,
  summarizeMessages,
  lastEventTime,
} from '../lib/session-view.js';

function ev(seq, type, data = {}) {
  return { seq, time: 1000 + seq, type, data };
}
function userMsg(seq, text, turn) {
  return ev(seq, 'user/message', { turn, content: [{ type: 'text', text }] });
}
function assistantMsg(seq, text, turn) {
  return ev(seq, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
}

describe('lastTurnSpan', () => {
  it('prefers the open turn over the last ended one', () => {
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev(2, 'turn/start', { turn: 2 }),
      assistantMsg(3, 'working', 2),
    ];
    const span = lastTurnSpan(events);
    assert.equal(span?.turn, 2);
    assert.equal(span?.reason, undefined);
  });

  it('returns the last ended turn when nothing is open', () => {
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'y' } } }),
    ];
    assert.equal(lastTurnSpan(events)?.reason?.kind, 'error');
    assert.equal(lastTurnSpan([]), undefined);
  });
});

describe('assistantTextForTurn', () => {
  it('concatenates same-turn text parts', () => {
    const events = [assistantMsg(0, 'hello ', 1), assistantMsg(1, 'world', 1), assistantMsg(2, 'other', 2)];
    assert.equal(assistantTextForTurn(events, 1), 'hello \nworld');
    assert.equal(assistantTextForTurn(events, 9), '');
  });
});

describe('toolCallsForTurn', () => {
  it('pairs calls with results and bounds items', () => {
    const events = [
      ev(0, 'tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
      ev(1, 'tool/call', { turn: 1, callId: 'c2', name: 'read', arguments: '{}' }),
      ev(2, 'tool/result', { turn: 1, message: { source: { callId: 'c1' }, content: [{ isError: true }] } }),
    ];
    const calls = toolCallsForTurn(events, 1, 10);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].isError, true);
    assert.equal(calls[1].isError ?? false, false);
    assert.equal(toolCallsForTurn(events, 1, 1).length, 1);
  });
});

describe('changedFilesForTurn', () => {
  it('collects edit tool paths in order', () => {
    const events = [
      ev(0, 'tool/call', { turn: 2, name: 'write', arguments: '{"file_path":"/a.ts","content":"x"}' }),
      ev(1, 'tool/call', { turn: 2, name: 'bash', arguments: '{"command":"ls"}' }),
      ev(2, 'tool/call', { turn: 2, name: 'edit', arguments: '{"path":"/b.ts"}' }),
      ev(3, 'tool/call', { turn: 2, name: 'write', arguments: 'not-json' }),
      ev(4, 'tool/call', { turn: 3, name: 'write', arguments: '{"file_path":"/c.ts"}' }),
    ];
    assert.deepEqual(changedFilesForTurn(events, 2), ['/a.ts', '/b.ts']);
  });
});

describe('summarizeMessages / lastEventTime', () => {
  it('bounds items and chars, newest first', () => {
    const events = [userMsg(0, 'one', 1), assistantMsg(1, 'two', 1), userMsg(2, 'three', 2)];
    const rows = summarizeMessages(events, 2, 3);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].text, 'thr…[truncated]');
    assert.equal(lastEventTime(events), new Date(1002).toISOString());
    assert.equal(lastEventTime([]), undefined);
  });
});
