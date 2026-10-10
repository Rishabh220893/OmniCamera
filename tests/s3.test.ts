import test from 'node:test';
import assert from 'node:assert/strict';
import { awsEncode, signV4, EMPTY_SHA256 } from '../server/recording/s3.ts';

const KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };

// The three worked examples in AWS's "Signature Calculations for the Authorization Header" documentation.
test('signature V4 reproduces AWS\'s own GET object example (with a signed Range header)', () => {
  const s = signV4({ ...KEYS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 });
  assert.equal(s.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  assert.equal(s.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(s.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('signature V4 reproduces AWS\'s PUT object example (encoded key, extra signed headers, a body hash)', () => {
  const s = signV4({
    ...KEYS, method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: `/${awsEncode('test$file.text')}`,
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
  });
  assert.equal(s.signedHeaders, 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
  assert.equal(s.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('signature V4 reproduces AWS\'s list-objects example (query parameters)', () => {
  const s = signV4({ ...KEYS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: EMPTY_SHA256 });
  assert.equal(s.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('encoding: unreserved characters stay, everything else is %XX, slashes kept only in paths', () => {
  assert.equal(awsEncode('a b/c+d~e_f-g.h'), 'a%20b%2Fc%2Bd~e_f-g.h');
  assert.equal(awsEncode('cam 1/2026-10-10_10-00-00-000000.mp4', true), 'cam%201/2026-10-10_10-00-00-000000.mp4');
  assert.equal(awsEncode("it's (a) *test*!"), 'it%27s%20%28a%29%20%2Atest%2A%21');
  assert.equal(awsEncode('नमस्ते'), '%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87');
});
