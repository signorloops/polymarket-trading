import { createSingleton } from '../../src/utils/singleton';

describe('createSingleton', () => {
  it('should return the same instance on multiple get() calls', () => {
    let callCount = 0;
    const singleton = createSingleton(() => {
      callCount++;
      return { id: callCount };
    });

    const a = singleton.get();
    const b = singleton.get();
    expect(a).toBe(b);
    expect(callCount).toBe(1);
  });

  it('should create a new instance after reset()', () => {
    let callCount = 0;
    const singleton = createSingleton(() => {
      callCount++;
      return { id: callCount };
    });

    const a = singleton.get();
    singleton.reset();
    const b = singleton.get();
    expect(a).not.toBe(b);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(callCount).toBe(2);
  });

  it('should not call factory until first get()', () => {
    let called = false;
    const singleton = createSingleton(() => {
      called = true;
      return 'value';
    });

    expect(called).toBe(false);
    singleton.get();
    expect(called).toBe(true);
  });
});
