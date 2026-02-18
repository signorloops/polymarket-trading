/**
 * Graceful shutdown manager
 *
 * Handles process signals and coordinates graceful shutdown:
 * - SIGTERM/SIGINT/SIGHUP handling
 * - Component shutdown sequence
 * - Timeout management
 * - State persistence
 * - Force exit as last resort
 *
 * Features:
 * - Priority-based component shutdown
 * - Phase-based shutdown sequence
 * - Timeout handling with force exit
 * - Comprehensive logging
 */

import { getLogger } from '../utils/logger.js';

export interface ComponentStatus {
  id: string;
  healthy: boolean;
  pendingOperations: number;
  lastActivity: number;
}

export interface LifecycleComponent {
  id: string;
  priority: number;
  healthCheck?(): Promise<boolean>;
  destroy(): Promise<void>;
  getStatus?(): ComponentStatus;
}

export interface PhaseResult {
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ShutdownStats {
  totalDurationMs: number;
  phaseResults: PhaseResult[];
  forced: boolean;
  exitCode: number;
  signal: string;
}

export interface ShutdownConfig {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
  phases: ShutdownPhase[];
  onShutdownStart?(signal: string): void;
  onPhaseComplete?(phase: string, durationMs: number): void;
  onShutdownComplete?(stats: ShutdownStats): void;
  onForceExit?(reason: string): void;
}

export interface ShutdownPhase {
  name: string;
  timeoutMs: number;
  execute(): Promise<void>;
  skippable: boolean;
  continueOnError: boolean;
}

export interface ILifecycleManager {
  register(component: LifecycleComponent): void;
  unregister(componentId: string): void;
  shutdown(signal: string): Promise<void>;
  forceExit(reason: string, exitCode: number): void;
  isShuttingDown(): boolean;
  getComponents(): LifecycleComponent[];
}

/**
 * Lifecycle manager for graceful shutdown
 */
export class LifecycleManager implements ILifecycleManager {
  private components = new Map<string, LifecycleComponent>();
  private shuttingDown = false;
  private config: ShutdownConfig;
  private logger = getLogger().child({ module: 'LifecycleManager' });
  private forceExitTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<ShutdownConfig>) {
    this.config = {
      gracefulTimeoutMs: 30000,
      forceTimeoutMs: 5000,
      phases: [],
      ...config,
    };
  }

  /**
   * Register a component for lifecycle management
   */
  register(component: LifecycleComponent): void {
    if (this.shuttingDown) {
      throw new Error('Cannot register components during shutdown');
    }

    if (this.components.has(component.id)) {
      this.logger.warn(`Component ${component.id} already registered, replacing`);
    }

    this.components.set(component.id, component);
    this.logger.debug(`Registered component: ${component.id} (priority: ${component.priority})`);
  }

  /**
   * Unregister a component
   */
  unregister(componentId: string): void {
    this.components.delete(componentId);
    this.logger.debug(`Unregistered component: ${componentId}`);
  }

  /**
   * Get all registered components
   */
  getComponents(): LifecycleComponent[] {
    return Array.from(this.components.values());
  }

  /**
   * Get components sorted by priority (ascending)
   */
  private getSortedComponents(): LifecycleComponent[] {
    return Array.from(this.components.values()).sort(
      (a, b) => a.priority - b.priority
    );
  }

  /**
   * Execute shutdown sequence
   */
  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) {
      this.logger.info('Shutdown already in progress...');
      return;
    }

    this.shuttingDown = true;
    const startTime = Date.now();
    const phaseResults: PhaseResult[] = [];

    this.logger.info(`Starting graceful shutdown (signal: ${signal})...`);
    this.config.onShutdownStart?.(signal);

    // Set force exit timer
    this.forceExitTimer = setTimeout(() => {
      this.forceExit('Graceful timeout exceeded', 1);
    }, this.config.gracefulTimeoutMs);

    try {
      // Execute custom phases first
      for (const phase of this.config.phases) {
        const result = await this.executePhase(phase);
        phaseResults.push(result);

        this.config.onPhaseComplete?.(phase.name, result.durationMs);

        if (!result.success && !phase.continueOnError) {
          throw new Error(`Phase ${phase.name} failed: ${result.error}`);
        }
      }

      // Destroy components in priority order
      const componentPhase: ShutdownPhase = {
        name: 'destroy-components',
        timeoutMs: 10000,
        skippable: false,
        continueOnError: true,
        execute: async () => {
          await this.destroyComponents();
        },
      };

      const componentResult = await this.executePhase(componentPhase);
      phaseResults.push(componentResult);

      // Clear force exit timer
      if (this.forceExitTimer) {
        clearTimeout(this.forceExitTimer);
        this.forceExitTimer = null;
      }

      const stats: ShutdownStats = {
        totalDurationMs: Date.now() - startTime,
        phaseResults,
        forced: false,
        exitCode: 0,
        signal,
      };

      this.logger.info('Graceful shutdown complete', {
        durationMs: stats.totalDurationMs,
        phases: phaseResults.length,
      });

      this.config.onShutdownComplete?.(stats);
      process.exit(0);
    } catch (error) {
      this.logger.error('Graceful shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.forceExit('Shutdown error', 1);
    }
  }

  /**
   * Execute a shutdown phase with timeout
   */
  private async executePhase(phase: ShutdownPhase): Promise<PhaseResult> {
    const startTime = Date.now();
    this.logger.debug(`Executing phase: ${phase.name}`);

    try {
      await Promise.race([
        phase.execute(),
        this.createTimeout(phase.timeoutMs, phase.name),
      ]);

      const durationMs = Date.now() - startTime;
      this.logger.debug(`Phase complete: ${phase.name} (${durationMs}ms)`);

      return {
        name: phase.name,
        durationMs,
        success: true,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(`Phase failed: ${phase.name}`, {
        durationMs,
        error: errorMessage,
      });

      return {
        name: phase.name,
        durationMs,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number, context: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms: ${context}`));
      }, ms);
    });
  }

  /**
   * Destroy all components in priority order
   */
  private async destroyComponents(): Promise<void> {
    const components = this.getSortedComponents();

    this.logger.info(`Destroying ${components.length} components...`);

    for (const component of components) {
      try {
        this.logger.debug(`Destroying component: ${component.id}`);
        await component.destroy();
        this.logger.debug(`Component destroyed: ${component.id}`);
      } catch (error) {
        this.logger.error(`Failed to destroy component: ${component.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other components
      }
    }
  }

  /**
   * Force exit after timeout
   */
  forceExit(reason: string, exitCode: number): void {
    this.logger.error(`Force exit: ${reason}`);
    this.config.onForceExit?.(reason);

    // Clear any existing timer
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
    }

    // Force exit after brief delay for logs to flush
    setTimeout(() => {
      process.exit(exitCode);
    }, this.config.forceTimeoutMs);
  }

  /**
   * Check if shutdown is in progress
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

// Singleton instance
let globalLifecycleManager: LifecycleManager | null = null;

export function getLifecycleManager(
  config?: Partial<ShutdownConfig>
): LifecycleManager {
  globalLifecycleManager ??= new LifecycleManager(config);
  return globalLifecycleManager;
}

export function resetLifecycleManager(): void {
  globalLifecycleManager = null;
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupSignalHandlers(
  manager: ILifecycleManager,
  signals: string[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
): void {
  for (const signal of signals) {
    process.on(signal, async () => {
      await manager.shutdown(signal);
    });
  }

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    const logger = getLogger();
    logger.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
    manager.forceExit('Uncaught exception', 1);
  });

  // Handle unhandled rejections
  process.on('unhandledRejection', (reason) => {
    const logger = getLogger();
    logger.error('Unhandled rejection', { reason });
    manager.forceExit('Unhandled rejection', 1);
  });
}

/**
 * Create default shutdown configuration for trading system
 */
export function createDefaultShutdownConfig(
  options: {
    pauseTrading?: () => void;
    cancelPendingOrders?: (timeoutMs: number) => Promise<void>;
    closeConnections?: () => Promise<void>;
    persistState?: () => Promise<void>;
  } = {}
): ShutdownConfig {
  return {
    gracefulTimeoutMs: 30000,
    forceTimeoutMs: 5000,

    phases: [
      {
        name: 'pause-trading',
        timeoutMs: 5000,
        skippable: false,
        continueOnError: true,
        execute: async () => {
          options.pauseTrading?.();
        },
      },
      {
        name: 'cancel-pending-orders',
        timeoutMs: 10000,
        skippable: false,
        continueOnError: true,
        execute: async () => {
          await options.cancelPendingOrders?.(8000);
        },
      },
      {
        name: 'close-connections',
        timeoutMs: 5000,
        skippable: false,
        continueOnError: true,
        execute: async () => {
          await options.closeConnections?.();
        },
      },
      {
        name: 'persist-state',
        timeoutMs: 5000,
        skippable: false,
        continueOnError: false,
        execute: async () => {
          await options.persistState?.();
        },
      },
    ],
  };
}
