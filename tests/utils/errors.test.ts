import { getErrorMessage } from '../../src/utils/errors';

describe('getErrorMessage', () => {
  it('should extract message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('should convert string to string', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('should convert number to string', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('should handle null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('should handle undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
