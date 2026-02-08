/**
 * Dependency Injection Container
 *
 * Provides a simple DI container for managing component dependencies.
 * Replaces singleton pattern with explicit dependency injection.
 */

import { getLogger, Logger } from '../utils/logger.js';
import type { AppConfig } from '../utils/config-schema.js';
import { createDefaultConfig } from '../utils/config-schema.js';

type Constructor<T> = new (...args: unknown[]) => T;
type Factory<T> = (container: Container) => T;

interface Registration<T> {
  factory: Factory<T>;
  instance?: T;
  singleton: boolean;
}

export class Container {
  private registrations: Map<string, Registration<unknown>> = new Map();
  private instances: Map<string, unknown> = new Map();
  private logger: Logger;

  constructor() {
    this.logger = getLogger().child({ module: 'DIContainer' });
  }

  /**
   * Register a singleton service
   */
  registerSingleton<T>(token: string, factory: Factory<T>): this {
    this.registrations.set(token, { factory, singleton: true });
    this.logger.debug(`Registered singleton: ${token}`);
    return this;
  }

  /**
   * Register a transient (non-singleton) service
   */
  registerTransient<T>(token: string, factory: Factory<T>): this {
    this.registrations.set(token, { factory, singleton: false });
    this.logger.debug(`Registered transient: ${token}`);
    return this;
  }

  /**
   * Register an instance directly
   */
  registerInstance<T>(token: string, instance: T): this {
    this.instances.set(token, instance);
    this.logger.debug(`Registered instance: ${token}`);
    return this;
  }

  /**
   * Resolve a service by token
   */
  resolve<T>(token: string): T {
    // Return existing instance
    const existing = this.instances.get(token);
    if (existing) {
      return existing as T;
    }

    // Create from factory
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new Error(`No registration found for token: ${token}`);
    }

    const instance = registration.factory(this);

    if (registration.singleton) {
      this.instances.set(token, instance);
    }

    return instance as T;
  }

  /**
   * Check if a token is registered
   */
  has(token: string): boolean {
    return this.registrations.has(token) || this.instances.has(token);
  }

  /**
   * Clear all registrations and instances
   */
  clear(): void {
    this.registrations.clear();
    this.instances.clear();
    this.logger.debug('Container cleared');
  }

  /**
   * Create a child container that inherits registrations
   */
  createChild(): Container {
    const child = new Container();

    // Copy registrations
    for (const [token, reg] of this.registrations) {
      child.registrations.set(token, reg);
    }

    // Copy singleton instances
    for (const [token, instance] of this.instances) {
      child.instances.set(token, instance);
    }

    return child;
  }
}

// Service tokens
export const Tokens = {
  Config: 'config',
  Logger: 'logger',
  OrderBookManager: 'orderBookManager',
  RiskManager: 'riskManager',
  ExecutionEngine: 'executionEngine',
  ArbitrageDetector: 'arbitrageDetector',
  StrategyManager: 'strategyManager',
  PolymarketClient: 'polymarketClient',
  PolymarketWebSocketClient: 'polymarketWebSocketClient',
} as const;

// Global container instance
let globalContainer: Container | null = null;

export function createContainer(config?: AppConfig): Container {
  const container = new Container();
  const appConfig = config ?? createDefaultConfig();

  // Register configuration
  container.registerInstance(Tokens.Config, appConfig);

  // Register logger
  container.registerSingleton(Tokens.Logger, (c) => {
    const cfg = c.resolve<AppConfig>(Tokens.Config);
    return getLogger().child({ module: 'App' });
  });

  return container;
}

export function getContainer(): Container {
  if (!globalContainer) {
    globalContainer = createContainer();
  }
  return globalContainer;
}

export function resetContainer(): void {
  globalContainer = null;
}
