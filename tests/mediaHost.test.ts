import test from 'node:test';
import assert from 'node:assert/strict';
import { shardedMediaBase } from '../src/lib/mediaHost';

test('a local media server gets one host per camera so each has its own connection pool', () => {
  assert.equal(shardedMediaBase('http://localhost:8888', 'cam01'), 'http://cam01.localhost:8888');
  assert.equal(shardedMediaBase('http://localhost:8888/', 'CAM07'), 'http://cam07.localhost:8888');
});

test('other media server addresses are left alone', () => {
  assert.equal(shardedMediaBase('https://omnicamera-ws.onrender.com', 'cam01'), 'https://omnicamera-ws.onrender.com');
  assert.equal(shardedMediaBase('http://127.0.0.1:8888', 'cam01'), 'http://127.0.0.1:8888');
  assert.equal(shardedMediaBase('http://192.168.1.20:8888/', 'cam01'), 'http://192.168.1.20:8888');
});

test('an odd camera id or a non-URL is not turned into a hostname', () => {
  assert.equal(shardedMediaBase('http://localhost:8888', 'a b/c'), 'http://localhost:8888');
  assert.equal(shardedMediaBase('not a url', 'cam01'), 'not a url');
  assert.equal(shardedMediaBase('', 'cam01'), '');
});
