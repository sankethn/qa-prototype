import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samePageShape } from './replay.js';

// URL comparison decides whether a step is even attempted, so a false positive
// here fails healthy tests and a false negative lets the healer loose on the
// wrong page. Neither is reachable through the fault drill: it needs a real app
// with dynamic routes, and the function is pure anyway.

test('identical URLs are the same page', () => {
  assert.equal(samePageShape('http://x/home', 'http://x/home'), true);
});

test('a trailing slash is not a difference', () => {
  assert.equal(samePageShape('http://x/home/', 'http://x/home'), true);
});

test('query strings and hashes are ignored', () => {
  // Tracking params, cache-busters and RSC markers differ run to run.
  assert.equal(samePageShape('http://x/home?utm=a', 'http://x/home?_rsc=b'), true);
  assert.equal(samePageShape('http://x/home#top', 'http://x/home'), true);
});

test('different paths are different pages', () => {
  // The case that matters: a session expiring and redirecting to a login page.
  assert.equal(samePageShape('http://x/home', 'http://x/login'), false);
});

test('numeric id segments are normalised', () => {
  assert.equal(samePageShape('http://x/orders/12345', 'http://x/orders/67890'), true);
});

test('hex and uuid segments are normalised', () => {
  assert.equal(samePageShape('http://x/u/a1b2c3d4e5', 'http://x/u/9f8e7d6c5b'), true);
  assert.equal(
    samePageShape(
      'http://x/i/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'http://x/i/8a7b6c5d-1e2f-11d3-9a0c-0305e82c3301',
    ),
    true,
  );
});

test('an id in one path does not match a word in the other', () => {
  assert.equal(samePageShape('http://x/orders/12345', 'http://x/orders/new'), false);
});

test('extra path segments are a difference', () => {
  assert.equal(samePageShape('http://x/orders', 'http://x/orders/12345'), false);
});

test('a different origin is a different page', () => {
  assert.equal(samePageShape('http://x/home', 'http://y/home'), false);
});

test('an unparseable URL is not treated as divergence', () => {
  // Better to attempt the step and fail on its own terms than to invent a
  // divergence from a URL we could not read.
  assert.equal(samePageShape('not-a-url', 'http://x/home'), true);
});
