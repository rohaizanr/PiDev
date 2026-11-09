import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, parseDotenv } from '../src/config.js';
import { isAuthorizedUser, isAuthorizedUpdate, parseAllowedUserIds } from '../src/auth.js';
import { makeWorkspace, GOOD_ENV } from './helpers.js';

// 1. configuration validation and missing-secret behaviour
test('valid configuration passes', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const v = validateConfig(GOOD_ENV(ws.root));
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(v.config.allowedUserIds, ['111111111']);
});

test('missing token, chat id and owner ids fail closed', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const v = validateConfig({ PIDEV_WORKSPACE_ROOT: ws.root });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('OPENACP_TELEGRAM_BOT_TOKEN is missing')));
  assert.ok(v.errors.some((e) => e.includes('OPENACP_TELEGRAM_CHAT_ID is missing')));
  assert.ok(v.errors.some((e) => e.includes('fails closed')));
  assert.deepEqual(v.config.allowedUserIds, []);
});

test('validation errors never contain the secret value', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const bad = 'not-a-token-but-still-secret-value-123';
  const v = validateConfig({ ...GOOD_ENV(ws.root), OPENACP_TELEGRAM_BOT_TOKEN: bad });
  assert.equal(v.ok, false);
  assert.ok(!JSON.stringify(v).includes(bad));
  const good = GOOD_ENV(ws.root).OPENACP_TELEGRAM_BOT_TOKEN;
  assert.ok(!JSON.stringify(validateConfig(GOOD_ENV(ws.root))).includes(good));
});

test('usernames and private-chat ids are rejected as configuration', (t) => {
  const ws = makeWorkspace(); t.after(ws.cleanup);
  const v = validateConfig({ ...GOOD_ENV(ws.root), PIDEV_ALLOWED_USER_IDS: '@owner', OPENACP_TELEGRAM_CHAT_ID: '111111111' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('non-numeric')));
  assert.ok(v.errors.some((e) => e.includes('-100')));
});

test('relative or missing workspace root is rejected', () => {
  assert.equal(validateConfig({ ...GOOD_ENV('relative/path') }).ok, false);
  assert.equal(validateConfig({ ...GOOD_ENV('/definitely/not/here/pidev') }).ok, false);
});

test('dotenv parser handles quotes and comments without expansion', () => {
  const env = parseDotenv('# c\nA=1\nB="two words"\nC=x # trailing\nexport D=$HOME\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: '$HOME' });
});

// 2. allowlisted identity accepted / unknown rejected
test('allowlisted numeric user accepted, unknown rejected', () => {
  const allowed = parseAllowedUserIds('111111111, 222222222').valid;
  assert.equal(isAuthorizedUser(111111111, allowed), true);
  assert.equal(isAuthorizedUser('222222222', allowed), true);
  assert.equal(isAuthorizedUser('333333333', allowed), false);
  assert.equal(isAuthorizedUser('owner_username', allowed), false);
  assert.equal(isAuthorizedUser(undefined, allowed), false);
});

test('empty allowlist accepts nobody (fail closed)', () => {
  assert.equal(isAuthorizedUser('111111111', []), false);
  assert.equal(isAuthorizedUser('111111111', parseAllowedUserIds('').valid), false);
});

// 3. group chat rejected (only the configured private forum supergroup is accepted)
test('only the configured supergroup + owner passes the update policy', () => {
  const cfg = { chatId: -1001234567890, allowedUserIds: ['111111111'] };
  const ok = { chatId: -1001234567890, chatType: 'supergroup', userId: '111111111' };
  assert.equal(isAuthorizedUpdate(ok, cfg), true);
  assert.equal(isAuthorizedUpdate({ ...ok, chatType: 'group', chatId: -4000000001 }, cfg), false, 'other group');
  assert.equal(isAuthorizedUpdate({ ...ok, chatId: -1009999999999 }, cfg), false, 'other supergroup');
  assert.equal(isAuthorizedUpdate({ ...ok, chatType: 'private', chatId: 111111111 }, cfg), false, 'private chat');
  assert.equal(isAuthorizedUpdate({ ...ok, chatType: 'channel' }, cfg), false, 'channel');
  assert.equal(isAuthorizedUpdate({ userId: '111111111' }, cfg), false, 'inline query (no chat)');
  assert.equal(isAuthorizedUpdate({ ...ok, userId: '999' }, cfg), false, 'stranger in the group');
  assert.equal(isAuthorizedUpdate(ok, { chatId: null, allowedUserIds: ['111111111'] }), false, 'unconfigured chat');
});
