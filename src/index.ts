/**
 * NodeThreads
 * A lightweight library for effortless multithreading in Node.js
 */

import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import EventEmitter from 'events';

// Type definitions
export type ThreadFunction<T, R> = (data: T, options?: ThreadExecutionOptions) => R | Promise<R>;
export type ProgressCallback = (progress: number, message?: string) => void;

export interface ThreadOptions {
  maxThreads?: number;
  autoTerminate?: boolean;
  tempDir?: string;
  enableCaching?: boolean;
}

export interface ThreadExecutionOptions {
  onProgress?: ProgressCallback;
  timeout?: number;
  priority?: 'high' | 'normal' | 'low';
  retries?: number;
  retryDelay?: number;
}

export interface ThreadResult<R> {
  promise: Promise<R>;
  cancel: () => void;
  worker: Worker;
}

// Custom error classes
export class ThreadError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = 'ThreadError';
    if (originalError) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

export class ThreadTimeoutError extends ThreadError {
  constructor(timeout: number) {
    super(`Thread execution timed out after ${timeout}ms`);
    this.name = 'ThreadTimeoutError';
  }
}

export class ThreadCancelledError extends ThreadError {
  constructor() {
    super('Thread execution was cancelled');
    this.name = 'ThreadCancelledError';
  }
}

// Main ThreadPool class
export class ThreadPool {
  private maxThreads: number;
  private autoTerminate: boolean;
  private tempDir: string;
  private enableCaching: boolean;
  private activeThreads: number = 0;
  private queue: Array<() => void> = [];
  private workerScripts: Map<string, string> = new Map();
  private activeWorkers: Set<Worker> = new Set();
  private resultCache: Map<string, any> = new Map();

  /**
   * Creates a new thread pool
   * 
   * @param options - Configuration options for the thread pool
   */
  constructor(options?: ThreadOptions) {
    this.maxThreads = options?.maxThreads || os.cpus().length;
    this.autoTerminate = options?.autoTerminate !== false;
    this.tempDir = options?.tempDir || path.join(process.cwd(), '.thread-temp');
    this.enableCaching = options?.enableCaching || false;
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    // Set up cleanup on process exit
    process.on('exit', () => {
      this.cleanup();
    });
  }

  /**
   * Run a function in a separate thread
   * 
   * @param fn - The function to run in a separate thread
   * @param data - The data to pass to the function
   * @param options - Optional execution options
   * @returns An object containing the promise and cancel function
   */
  run<T, R>(fn: ThreadFunction<T, R>, data: T, options?: ThreadExecutionOptions): ThreadResult<R> {
    // Check cache if enabled
    if (this.enableCaching) {
      const cacheKey = this.getCacheKey(fn, data);
      if (this.resultCache.has(cacheKey)) {
        const cachedResult = this.resultCache.get(cacheKey);
        const dummyWorker = new EventEmitter() as unknown as Worker;
        return {
          promise: Promise.resolve(cachedResult),
          cancel: () => {}, // No-op for cached results.
          worker: dummyWorker
        };
      }
    }

    // Create a worker script for this function if it doesn't exist
    const fnId = this.getFunctionId(fn);
    if (!this.workerScripts.has(fnId)) {
      this.createWorkerScript(fnId, fn);
    }
    
    const scriptPath = this.workerScripts.get(fnId)!;
    let worker: Worker | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let isCancelled = false;
    let retryCount = 0;
    const maxRetries = options?.retries || 0;
    const retryDelay = options?.retryDelay || 1000;
    
    // Create the promise
    const promise = new Promise<R>((resolve, reject) => {
      const executeTask = () => {
        this.activeThreads++;
        
        try {
          // Create worker
          worker = new Worker(scriptPath, {
            workerData: {
              data,
              options
            }
          });
          
          this.activeWorkers.add(worker);
          
          // Set up timeout if specified
          if (options?.timeout) {
            timeoutId = setTimeout(() => {
              const error = new ThreadTimeoutError(options.timeout!);
              reject(error);
              this.cleanupWorker(worker, timeoutId);
            }, options.timeout);
          }
          
          // Handle messages from worker
          worker.on('message', (message) => {
            if (message.type === 'result') {
              // Cache result if enabled
              if (this.enableCaching) {
                const cacheKey = this.getCacheKey(fn, data);
                this.resultCache.set(cacheKey, message.data);
              }
              
              resolve(message.data);
              this.cleanupWorker(worker, timeoutId);
            } else if (message.type === 'error') {
              const error = new ThreadError(
                message.message, 
                message.stack ? new Error(message.stack) : undefined
              );
              
              // Retry logic
              if (retryCount < maxRetries) {
                retryCount++;
                this.cleanupWorker(worker, timeoutId);
                
                setTimeout(() => {
                  executeTask();
                }, retryDelay);
              } else {
                reject(error);
                this.cleanupWorker(worker, timeoutId);
              }
            } else if (message.type === 'progress') {
              // empty line
            }
          });
          
          // Handle worker errors
          worker.on('error', (error) => {
            // Retry logic
            if (retryCount < maxRetries) {
              retryCount++;
              this.cleanupWorker(worker, timeoutId);
              
              setTimeout(() => {
                executeTask();
              }, retryDelay);
            } else {
              reject(new ThreadError(`Worker error: ${error.message}`, error));
              this.cleanupWorker(worker, timeoutId);
            }
          });
          
          // Handle worker exit
          worker.on('exit', (code) => {
            if (code !== 0 && worker) {
              // Retry logic
              if (retryCount < maxRetries) {
                retryCount++;
                this.cleanupWorker(worker, timeoutId);
                
                setTimeout(() => {
                  executeTask();
                }, retryDelay);
              } else {
                reject(new ThreadError(`Worker stopped with exit code ${code}`));
                this.cleanupWorker(worker, timeoutId);
              }
            }
          });
        } catch (error: unknown) {
          if (error instanceof Error) {
            reject(new ThreadError(`Failed to create worker: ${error.message}`, error));
          } else {
            reject(new ThreadError('Failed to create worker: Unknown error'));
          }
          this.activeThreads--;
          this.processQueue();
        }
      };
      
      // Execute immediately or queue based on priority
      if (this.activeThreads < this.maxThreads) {
        executeTask();
      } else {
        // Add to front of queue for high priority tasks
        if (options?.priority === 'high') {
          this.queue.unshift(executeTask);
        } 
        // Add to end of queue for normal/low priority tasks
        else {
          this.queue.push(executeTask);
        }
      }
    });
    
    // Handle cancellation
    const cancel = () => {
      if (worker && !isCancelled) {
        isCancelled = true;
        worker.postMessage({ type: 'cancel' });
        
        // Force terminate after a short delay if still running
        setTimeout(() => {
          if (worker) {
            worker.terminate();
            this.activeWorkers.delete(worker);
            worker = null;
            this.activeThreads--;
            this.processQueue();
          }
        }, 100);
      }
    };
    
    return { promise, cancel, worker: worker! };
  }
  
  /**
   * Run multiple tasks in parallel
   * 
   * @param fn - The function to run in separate threads
   * @param dataItems - Array of data items to process
   * @param options - Optional execution options
   * @returns Promise that resolves with an array of results
   */
  runAll<T, R>(fn: ThreadFunction<T, R>, dataItems: T[], options?: ThreadExecutionOptions): Promise<R[]> {
    const results: Promise<R>[] = [];
    
    for (const data of dataItems) {
      results.push(this.run(fn, data, options).promise);
    }
    
    return Promise.all(results);
  }
  
  /**
   * Map an array using a thread function
   * 
   * @param array - The array to map
   * @param fn - The function to apply to each item
   * @param options - Optional execution options
   * @returns Promise that resolves with an array of mapped results
   */
  map<T, R>(array: T[], fn: (item: T, index: number) => R, options?: ThreadExecutionOptions): Promise<R[]> {
    return this.runAll(
      (data: { item: T, index: number }) => fn(data.item, data.index),
      array.map((item, index) => ({ item, index })),
      options
    );
  }
  
  /**
   * Process array items in batches using threads
   * 
   * @param items - The array of items to process
   * @param fn - The function to process each batch
   * @param batchSize - The size of each batch
   * @param options - Optional execution options
   * @returns Promise that resolves with an array of results
   */
  async batch<T, R>(
    items: T[],
    fn: (batch: T[]) => R | Promise<R>,
    batchSize: number = 10,
    options?: ThreadExecutionOptions
  ): Promise<R[]> {
    const batches: T[][] = [];
    
    // Create batches
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    
    // Process all batches
    return this.runAll(fn, batches, options);
  }
  
  /**
   * Clean up resources for a specific worker
   * 
   * @param worker - The worker to clean up
   * @param timeoutId - The timeout ID to clear
   */
  private cleanupWorker(worker: Worker | null, timeoutId: NodeJS.Timeout | null): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    if (worker) {
      if (this.autoTerminate) {
        worker.terminate();
      }
      this.activeWorkers.delete(worker);
    }
    
    this.activeThreads--;
    this.processQueue();
  }
  
  /**
   * Process the next task in the queue
   */
  private processQueue(): void {
    if (this.queue.length > 0 && this.activeThreads < this.maxThreads) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        nextTask();
      }
    }
  }
  
  /**
   * Get a unique ID for a function
   * 
   * @param fn - The function to get an ID for
   * @returns A unique ID string
   */
  private getFunctionId(fn: Function): string {
    const fnString = fn.toString();
    return crypto.createHash('md5').update(fnString).digest('hex');
  }
  
  /**
   * Get a cache key for a function and data
   * 
   * @param fn - The function
   * @param data - The input data
   * @returns A cache key string
   */
  private getCacheKey(fn: Function, data: any): string {
    const fnId = this.getFunctionId(fn);
    const dataString = JSON.stringify(data);
    return crypto.createHash('md5').update(`${fnId}:${dataString}`).digest('hex');
  }
  
  /**
   * Create a worker script for a function
   * 
   * @param id - The function ID
   * @param fn - The function to create a script for
   */
  private createWorkerScript(id: string, fn: Function): void {
    const scriptPath = path.join(this.tempDir, `worker-${id}.js`);
    const scriptContent = `
      const { parentPort, workerData, isMainThread } = require('worker_threads');
      
      // Exit if this is not being run as a worker
      if (isMainThread) {
        throw new Error('This script is designed to be run as a worker thread');
      }
      
      // Get the function and data
      const fn = ${fn.toString()};
      const data = workerData.data;
      // Не передаємо options, щоб уникнути проблем з клонуванням
      
      // Flag to track cancellation
      let isCancelled = false;
      
      // Listen for cancel message
      parentPort.on('message', (message) => {
        if (message.type === 'cancel') {
          isCancelled = true;
        }
      });
      
      // Helper to report progress
      const reportProgress = (progress, message) => {
        if (parentPort) {
          parentPort.postMessage({
            type: 'progress',
            progress,
            message
          });
        }
      };
      
      // Add global helpers
      global.Thread = {
        isCancelled: () => isCancelled,
        reportProgress
      };
      
      // Execute the function
      (async () => {
        try {
          // Execute the function without passing options
          const result = await fn(data);
          
          // Check if cancelled before returning
          if (isCancelled) {
            parentPort.postMessage({
              type: 'error',
              message: 'Thread execution was cancelled'
            });
            return;
          }
          
          // Send the result back
          parentPort.postMessage({ type: 'result', data: result });
        } catch (error) {
          // Send the error back
          parentPort.postMessage({
            type: 'error',
            message: error.message,
            stack: error.stack
          });
        }
      })();
    `;
    
    fs.writeFileSync(scriptPath, scriptContent);
    this.workerScripts.set(id, scriptPath);
  }
  
  /**
   * Clean up all resources and temporary files
   */
  cleanup(): void {
    // Terminate all active workers
    for (const worker of this.activeWorkers) {
      worker.terminate();
    }
    this.activeWorkers.clear();
    
    // Delete all temporary files
    for (const scriptPath of this.workerScripts.values()) {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    }
    
    // Clear the maps
    this.workerScripts.clear();
    this.resultCache.clear();
  }
  
  /**
   * Clear the result cache
   */
  clearCache(): void {
    this.resultCache.clear();
  }
  
  /**
   * Get the number of active threads
   */
  get activeThreadCount(): number {
    return this.activeThreads;
  }
  
  /**
   * Get the number of queued tasks
   */
  get queuedTaskCount(): number {
    return this.queue.length;
  }
}

// Create a default thread pool
const defaultPool = new ThreadPool();

/**
 * Run a function in a separate thread using the default pool
 * 
 * @param fn - The function to run in a separate thread
 * @param data - The data to pass to the function
 * @param options - Optional execution options
 * @returns An object containing the promise and cancel function
 */
export function run<T, R>(fn: ThreadFunction<T, R>, data: T, options?: ThreadExecutionOptions): ThreadResult<R> {
  return defaultPool.run(fn, data, options);
}

/**
 * Run multiple tasks in parallel using the default pool
 * 
 * @param fn - The function to run in separate threads
 * @param dataItems - Array of data items to process
 * @param options - Optional execution options
 * @returns Promise that resolves with an array of results
 */
export function runAll<T, R>(fn: ThreadFunction<T, R>, dataItems: T[], options?: ThreadExecutionOptions): Promise<R[]> {
  return defaultPool.runAll(fn, dataItems, options);
}

/**
 * Map an array using a thread function with the default pool
 * 
 * @param array - The array to map
 * @param fn - The function to apply to each item
 * @param options - Optional execution options
 * @returns Promise that resolves with an array of mapped results
 */
export function map<T, R>(array: T[], fn: (item: T, index: number) => R, options?: ThreadExecutionOptions): Promise<R[]> {
  return defaultPool.map(array, fn, options);
}

/**
 * Process array items in batches using threads with the default pool
 * 
 * @param items - The array of items to process
 * @param fn - The function to process each batch
 * @param batchSize - The size of each batch
 * @param options - Optional execution options
 * @returns Promise that resolves with an array of results
 */
export function batch<T, R>(
  items: T[],
  fn: (batch: T[]) => R | Promise<R>,
  batchSize: number = 10,
  options?: ThreadExecutionOptions
): Promise<R[]> {
  return defaultPool.batch(items, fn, batchSize, options);
}

/**
 * Get the default thread pool instance
 * 
 * @returns The default ThreadPool instance
 */
export function getDefaultPool(): ThreadPool {
  return defaultPool;
}

/**
 * Clear the result cache of the default pool
 */
export function clearCache(): void {
  defaultPool.clearCache();
}

/**
 * Clean up all resources used by the default pool
 */
export function cleanup(): void {
  defaultPool.cleanup();
}

// Export Thread object for use in thread functions
export const Thread = {
  /**
   * Check if the current thread has been cancelled
   * 
   * @returns True if the thread has been cancelled, false otherwise
   */
  isCancelled: () => false,
  
  /**
   * Report progress from a thread
   * 
   * @param progress - The progress percentage (0-100)
   * @param message - Optional message describing the current progress state
   */
  reportProgress: (progress: number, message?: string) => {}
};

// Set up process exit handler
process.on('exit', () => {
  defaultPool.cleanup();
});
