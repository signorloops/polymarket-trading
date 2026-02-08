/**
 * DI Container Tests
 */

import { Container, Tokens, createContainer } from '../../src/di/container.js';

describe('DI Container', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  afterEach(() => {
    container.clear();
  });

  describe('registerSingleton', () => {
    it('should register and resolve singleton', () => {
      let callCount = 0;
      container.registerSingleton('test', () => {
        callCount++;
        return { value: callCount };
      });

      const instance1 = container.resolve<{ value: number }>('test');
      const instance2 = container.resolve<{ value: number }>('test');

      expect(instance1.value).toBe(1);
      expect(instance2.value).toBe(1);
      expect(callCount).toBe(1);
    });
  });

  describe('registerTransient', () => {
    it('should create new instances for each resolve', () => {
      let callCount = 0;
      container.registerTransient('test', () => {
        callCount++;
        return { value: callCount };
      });

      const instance1 = container.resolve<{ value: number }>('test');
      const instance2 = container.resolve<{ value: number }>('test');

      expect(instance1.value).toBe(1);
      expect(instance2.value).toBe(2);
      expect(callCount).toBe(2);
    });
  });

  describe('registerInstance', () => {
    it('should register pre-created instance', () => {
      const obj = { value: 42 };
      container.registerInstance('test', obj);

      const resolved = container.resolve<{ value: number }>('test');
      expect(resolved).toBe(obj);
      expect(resolved.value).toBe(42);
    });
  });

  describe('has', () => {
    it('should return true for registered tokens', () => {
      container.registerInstance('test', {});
      expect(container.has('test')).toBe(true);
    });

    it('should return false for unregistered tokens', () => {
      expect(container.has('unknown')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('should throw for unregistered token', () => {
      expect(() => container.resolve('unknown')).toThrow('No registration found');
    });
  });
});

describe('createContainer', () => {
  it('should create container with default config', () => {
    const container = createContainer();

    expect(container.has(Tokens.Config)).toBe(true);
    expect(container.has(Tokens.Logger)).toBe(true);

    container.clear();
  });
});
