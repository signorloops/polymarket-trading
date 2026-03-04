/**
 * Generic singleton factory. Eliminates boilerplate for the
 * `let instance | null; get(); reset();` pattern used across the codebase.
 */
export function createSingleton<T>(factory: () => T) {
  let instance: T | null = null;
  return {
    get: (): T => {
      instance ??= factory();
      return instance;
    },
    reset: (): void => {
      instance = null;
    },
  };
}
