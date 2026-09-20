import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should always return exactly 11 characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toHaveLength(11);
    }
  });

  it('should only use the base62 alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });

  it('should not repeat a value across 100000 consecutive calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      seen.add(generatePublicId());
    }

    expect(seen.size).toBe(100_000);
  });

  it('should draw from the whole alphabet rather than a degenerate subset', () => {
    const chars = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      for (const c of generatePublicId()) chars.add(c);
    }

    // 62 symbols over 55k draws — every symbol is expected with overwhelming
    // probability; a biased or truncated alphabet shows up immediately here.
    expect(chars.size).toBe(62);
  });

  it('should honour an explicit length', () => {
    expect(generatePublicId(5)).toHaveLength(5);
    expect(generatePublicId(32)).toHaveLength(32);
  });
});
