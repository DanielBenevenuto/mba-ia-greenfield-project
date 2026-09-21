import { formatContentRange, parseRangeHeader } from './range.util';

const SIZE = 10_000;

describe('parseRangeHeader', () => {
  it('should return undefined when no header is present', () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeUndefined();
    expect(parseRangeHeader('', SIZE)).toBeUndefined();
    expect(parseRangeHeader('   ', SIZE)).toBeUndefined();
  });

  it('should parse an explicit closed range', () => {
    expect(parseRangeHeader('bytes=0-1023', SIZE)).toEqual({
      start: 0,
      end: 1023,
    });
    expect(parseRangeHeader('bytes=500-999', SIZE)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('should parse an open-ended range as running to the last byte', () => {
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({
      start: 0,
      end: SIZE - 1,
    });
    expect(parseRangeHeader('bytes=9000-', SIZE)).toEqual({
      start: 9000,
      end: SIZE - 1,
    });
  });

  it('should parse a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({
      start: SIZE - 500,
      end: SIZE - 1,
    });
  });

  it('should clamp a suffix longer than the object to the whole object', () => {
    expect(parseRangeHeader('bytes=-99999', SIZE)).toEqual({
      start: 0,
      end: SIZE - 1,
    });
  });

  it('should clamp an end beyond the object to the last byte', () => {
    expect(parseRangeHeader('bytes=100-99999', SIZE)).toEqual({
      start: 100,
      end: SIZE - 1,
    });
  });

  it('should reject a start at or beyond the object size', () => {
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=999999999999-', SIZE)).toBeNull();
  });

  it('should reject an inverted range', () => {
    expect(parseRangeHeader('bytes=900-100', SIZE)).toBeNull();
  });

  it('should reject malformed headers', () => {
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toBeNull();
    expect(parseRangeHeader('items=0-100', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=-', SIZE)).toBeNull();
    expect(parseRangeHeader('0-100', SIZE)).toBeNull();
  });

  it('should reject a multi-range request rather than serve the wrong bytes', () => {
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toBeNull();
  });

  it('should reject a zero-length suffix', () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toBeNull();
  });
});

describe('formatContentRange', () => {
  it('should render the Content-Range header in the RFC form', () => {
    expect(formatContentRange({ start: 0, end: 1023 }, SIZE)).toBe(
      'bytes 0-1023/10000',
    );
  });
});
