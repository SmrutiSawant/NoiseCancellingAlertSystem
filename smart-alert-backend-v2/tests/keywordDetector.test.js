const KeywordDetector = require('../src/services/keywordDetector');

describe('KeywordDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new KeywordDetector({ cooldownMs: 0, maxPerMinute: 100 });
    detector.registerSession('s1', [
      { id: 'k1', word: 'Alice', matchMode: 'contains', caseSensitive: false },
      { id: 'k2', word: 'hey', matchMode: 'exact', caseSensitive: false },
    ]);
  });

  test('detects keyword in transcript', () => {
    const results = detector.analyze('s1', 'Did you hear that alice said something?');
    expect(results.length).toBe(1);
    expect(results[0].keyword.word).toBe('Alice');
  });

  test('exact match mode requires word boundary', () => {
    const noMatch = detector.analyze('s1', 'heya there');
    expect(noMatch.length).toBe(0);
    const match = detector.analyze('s1', 'hey there');
    expect(match.length).toBe(1);
  });

  test('case insensitive matching works', () => {
    const r = detector.analyze('s1', 'ALICE called');
    expect(r.length).toBe(1);
  });

  test('emits alert event on detection', (done) => {
    detector.once('alert', (payload) => {
      expect(payload.sessionId).toBe('s1');
      expect(payload.matchedWord).toBe('Alice');
      done();
    });
    detector.analyze('s1', 'alice is calling');
  });

  test('respects cooldown between alerts', () => {
    const det2 = new KeywordDetector({ cooldownMs: 5000, maxPerMinute: 100 });
    det2.registerSession('s2', [{ id: 'k1', word: 'test', matchMode: 'contains', caseSensitive: false }]);
    const r1 = det2.analyze('s2', 'test something');
    const r2 = det2.analyze('s2', 'another test'); // within cooldown
    expect(r1.length).toBe(1);
    expect(r2.length).toBe(0);
  });

  test('respects max alerts per minute', () => {
    const det3 = new KeywordDetector({ cooldownMs: 0, maxPerMinute: 2 });
    det3.registerSession('s3', ['ping']);
    det3.analyze('s3', 'ping 1');
    det3.analyze('s3', 'ping 2');
    const r = det3.analyze('s3', 'ping 3');
    expect(r.length).toBe(0);
  });

  test('fuzzy matching catches typos in long words', () => {
    const det4 = new KeywordDetector({ cooldownMs: 0, maxPerMinute: 100 });
    det4.registerSession('s4', [{ id: 'k1', word: 'Jonathan', matchMode: 'contains', caseSensitive: false }]);
    const r = det4.analyze('s4', 'joonathan is here');
    expect(r.length).toBe(1);
    expect(r[0].confidence).toBeLessThan(1);
  });

  test('returns empty for unknown session', () => {
    const r = detector.analyze('no-such-session', 'alice');
    expect(r.length).toBe(0);
  });

  test('updateKeywords changes detection', () => {
    detector.updateKeywords('s1', [{ id: 'k3', word: 'Bob', matchMode: 'contains', caseSensitive: false }]);
    const noAlice = detector.analyze('s1', 'alice called');
    expect(noAlice.length).toBe(0);
    const yesBob = detector.analyze('s1', 'bob called');
    expect(yesBob.length).toBe(1);
  });

  test('edit distance utility works correctly', () => {
    expect(detector._editDistance('kitten', 'sitting')).toBe(3);
    expect(detector._editDistance('alice', 'alice')).toBe(0);
    expect(detector._editDistance('alice', 'alicf')).toBe(1);
  });
});
