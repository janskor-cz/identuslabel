/**
 * Unit tests for messageFilters.ts logic
 *
 * Tests the pure filtering functions without needing a browser or SDK agent.
 * Mirrors the TypeScript logic using plain objects — no compilation required.
 */

'use strict';

const BASIC_MESSAGE_PIURI = 'https://didcomm.org/basicmessage/2.0/message';
const PRESENTATION_REQUEST_PIURIS = new Set([
  'https://didcomm.atalaprism.io/present-proof/3.0/request-presentation',
  'https://didcomm.org/present-proof/3.0/request-presentation',
]);
const CONNECTION_REQUEST_PIURIS = new Set([
  'https://atalaprism.io/mercury/connections/1.0/request',
  'https://didcomm.org/didexchange/1.0/request',
]);
const CREDENTIAL_PIURIS = new Set([
  'https://didcomm.org/issue-credential/3.0/offer-credential',
  'https://didcomm.org/issue-credential/3.0/request-credential',
  'https://didcomm.org/issue-credential/3.0/issue-credential',
  'https://didcomm.atalaprism.io/present-proof/3.0/request-presentation',
  'https://didcomm.atalaprism.io/present-proof/3.0/presentation',
]);

const MessageDirection = { SENT: 0, RECEIVED: 1 };

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMsg(piuri, direction = MessageDirection.RECEIVED, overrides = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    piuri,
    direction,
    from: { toString: () => 'did:peer:sender' },
    to:   { toString: () => 'did:peer:recipient' },
    body: '{}',
    createdTime: new Date().toISOString(),
    ...overrides,
  };
}

function filterChatMessages(msgs) {
  return msgs.filter(m => m.piuri === BASIC_MESSAGE_PIURI);
}

function filterConnectionMessages(msgs) {
  return msgs.filter(m => CONNECTION_REQUEST_PIURIS.has(m.piuri));
}

function filterCredentialMessages(msgs) {
  return msgs.filter(m => CREDENTIAL_PIURIS.has(m.piuri));
}

function filterPresentationRequests(msgs) {
  return msgs.filter(m => PRESENTATION_REQUEST_PIURIS.has(m.piuri));
}

function groupMessagesByType(msgs) {
  return {
    chatMessages:       filterChatMessages(msgs),
    protocolMessages:   msgs.filter(m => m.piuri !== BASIC_MESSAGE_PIURI),
    connectionMessages: filterConnectionMessages(msgs),
    credentialMessages: filterCredentialMessages(msgs),
  };
}

function getConversationId(msg) {
  const from = msg.from?.toString() || '';
  const to   = msg.to?.toString()   || '';
  return [...[from, to]].sort().join('_');
}

function toChatMessage(msg) {
  if (msg.piuri !== BASIC_MESSAGE_PIURI) return null;
  let content = '';
  try {
    const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
    content = body.content || '';
  } catch (_) {
    content = String(msg.body || '');
  }
  return {
    id:        msg.id,
    content,
    from:      msg.from?.toString() || '',
    to:        msg.to?.toString()   || '',
    direction: msg.direction,
    status:    msg.direction === MessageDirection.RECEIVED ? 'received' : 'sent',
    connectionId: getConversationId(msg),
  };
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function assertLength(arr, len, msg) {
  if (arr.length !== len) throw new Error(msg || `Expected length ${len}, got ${arr.length}`);
}

// ── tests ─────────────────────────────────────────────────────────────────────

console.log('\n📋 messageFilters — unit tests\n');

// filterChatMessages
test('filterChatMessages: returns only basic message piuri', () => {
  const msgs = [
    makeMsg(BASIC_MESSAGE_PIURI),
    makeMsg('https://didcomm.org/issue-credential/3.0/offer-credential'),
    makeMsg(BASIC_MESSAGE_PIURI),
  ];
  const result = filterChatMessages(msgs);
  assertLength(result, 2, 'Should return 2 basic messages');
  assert(result.every(m => m.piuri === BASIC_MESSAGE_PIURI), 'All results should be basic messages');
});

test('filterChatMessages: returns empty array when no basic messages', () => {
  const msgs = [
    makeMsg('https://didcomm.org/issue-credential/3.0/offer-credential'),
    makeMsg('https://didcomm.org/didexchange/1.0/request'),
  ];
  assertLength(filterChatMessages(msgs), 0);
});

test('filterChatMessages: does NOT match piuri that merely contains the keyword', () => {
  const msgs = [
    makeMsg('https://evil.example/basicmessage/2.0/message/extra'),
    makeMsg('https://didcomm.org/basicmessage/2.0/'),
  ];
  assertLength(filterChatMessages(msgs), 0, 'Partial matches should not be returned');
});

// filterPresentationRequests — ensures the Set-based match replaced the old .includes()
test('filterPresentationRequests: matches both Atala and standard piuris', () => {
  const msgs = [
    makeMsg('https://didcomm.atalaprism.io/present-proof/3.0/request-presentation'),
    makeMsg('https://didcomm.org/present-proof/3.0/request-presentation'),
    makeMsg(BASIC_MESSAGE_PIURI),
  ];
  assertLength(filterPresentationRequests(msgs), 2);
});

test('filterPresentationRequests: does NOT match piuri that only contains substring', () => {
  // Old code used .includes("request-presentation") — this is the regression test
  const msgs = [
    makeMsg('https://malicious.example/request-presentation/injected'),
    makeMsg('https://other.example/v1/request-presentation'),
  ];
  assertLength(filterPresentationRequests(msgs), 0,
    'Substring-match piuris should NOT be treated as presentation requests');
});

// filterConnectionMessages
test('filterConnectionMessages: matches standard and DIDExchange connection requests', () => {
  const msgs = [
    makeMsg('https://atalaprism.io/mercury/connections/1.0/request'),
    makeMsg('https://didcomm.org/didexchange/1.0/request'),
    makeMsg(BASIC_MESSAGE_PIURI),
  ];
  assertLength(filterConnectionMessages(msgs), 2);
});

// groupMessagesByType
test('groupMessagesByType: splits messages into correct buckets', () => {
  const msgs = [
    makeMsg(BASIC_MESSAGE_PIURI),
    makeMsg('https://didcomm.org/issue-credential/3.0/offer-credential'),
    makeMsg('https://didcomm.org/didexchange/1.0/request'),
  ];
  const grouped = groupMessagesByType(msgs);
  assertLength(grouped.chatMessages,       1, 'chatMessages');
  assertLength(grouped.protocolMessages,   2, 'protocolMessages (non-basic)');
  assertLength(grouped.connectionMessages, 1, 'connectionMessages');
  assertLength(grouped.credentialMessages, 1, 'credentialMessages');
});

// toChatMessage
test('toChatMessage: converts basic message with JSON body', () => {
  const msg = makeMsg(BASIC_MESSAGE_PIURI, MessageDirection.RECEIVED, {
    body: JSON.stringify({ content: 'Hello world' }),
  });
  const chat = toChatMessage(msg);
  assert(chat !== null, 'Should return a chat message');
  assertEqual(chat.content, 'Hello world');
  assertEqual(chat.status, 'received');
});

test('toChatMessage: returns null for non-basic messages', () => {
  const msg = makeMsg('https://didcomm.org/issue-credential/3.0/offer-credential');
  assert(toChatMessage(msg) === null, 'Non-basic message should return null');
});

test('toChatMessage: handles missing body.content gracefully', () => {
  const msg = makeMsg(BASIC_MESSAGE_PIURI, MessageDirection.RECEIVED, {
    body: JSON.stringify({}),
  });
  const chat = toChatMessage(msg);
  assertEqual(chat.content, '', 'Missing content should default to empty string');
});

test('toChatMessage: marks sent direction correctly', () => {
  const msg = makeMsg(BASIC_MESSAGE_PIURI, MessageDirection.SENT, {
    body: JSON.stringify({ content: 'Outgoing' }),
  });
  const chat = toChatMessage(msg);
  assertEqual(chat.status, 'sent');
});

// getConversationId
test('getConversationId: produces same ID regardless of message direction', () => {
  const msg1 = makeMsg(BASIC_MESSAGE_PIURI, MessageDirection.SENT, {
    from: { toString: () => 'did:peer:alice' },
    to:   { toString: () => 'did:peer:bob' },
  });
  const msg2 = makeMsg(BASIC_MESSAGE_PIURI, MessageDirection.RECEIVED, {
    from: { toString: () => 'did:peer:bob' },
    to:   { toString: () => 'did:peer:alice' },
  });
  assertEqual(getConversationId(msg1), getConversationId(msg2),
    'Conversation ID should be the same regardless of who sent the message');
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
