# threadmaster
A lightweight library for effortless multithreading in Node.js applications.

## Features

- Simple API - Run any function in a separate thread with minimal code
- Thread Pool Management - Automatic management of worker threads with configurable pool size
- Progress Tracking - Monitor the progress of long-running tasks
- Cancellation Support - Cancel running tasks when needed
- Error Handling - Robust error propagation between threads
- Retry Mechanism - Automatically retry failed operations
- Result Caching - Optional caching of results for identical inputs
- Batch Processing - Process large datasets in batches
- Priority Queuing - Prioritize important tasks
- TypeScript Support - Full type safety with TypeScript

## Installation

```bash
npm install threadmaster
```

## Basic Usage

```typescript
const { run, Thread } = require('threadmaster');

// Function to run in a separate thread
const heavyComputation = (data) => {
  let result = 0;
  
  for (let i = 0; i < data.iterations; i++) {
    // Check if cancelled
    if (Thread.isCancelled()) {
      return { cancelled: true, progress: i / data.iterations };
    }
    
    // Report progress
    if (i % 1000000 === 0) {
      Thread.reportProgress(i / data.iterations * 100, `Processed ${i} items`);
    }
    
    // Perform computation
    result += Math.sqrt(i);
  }
  
  return { result };
};

// Run the function in a separate thread
async function main() {
  const { promise, cancel } = run(
    heavyComputation,
    { iterations: 10000000 },
    { 
      onProgress: (progress, message) => {
        console.log(`Progress: ${progress.toFixed(2)}% - ${message}`);
      },
      timeout: 5000 // 5 seconds
    }
  );
  
  // Optional: Cancel after 2 seconds
  setTimeout(() => {
    console.log('Cancelling...');
    cancel();
  }, 2000);
  
  try {
    const result = await promise;
    console.log('Result:', result);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
```
## API Reference
Core Functions

**run(fn, data, options)**

Runs a function in a separate thread.

```typescript
const { promise, cancel } = run(
  (data) => data.x + data.y,
  { x: 5, y: 10 },
  { timeout: 1000 }
);

const result = await promise;
```

**runAll(fn, dataItems, options)**

Runs a function for multiple data items in parallel.

```typescript
const results = await runAll(
  (item) => item * 2,
  [1, 2, 3, 4, 5]
);
// [2, 4, 6, 8, 10]
```

**map(array, fn, options)**
Maps an array using a thread function.

```typescript
const squares = await map(
  [1, 2, 3, 4, 5],
  (item) => item * item
);
// [1, 4, 9, 16, 25]
```

**batch(items, fn, batchSize, options)**
Processes array items in batches.

```typescript
const results = await batch(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  (batch) => batch.map(x => x * 2),
  3
);
// [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
```

### Thread Object

The Thread object is available inside thread functions:

- Thread.isCancelled() - Check if the thread has been cancelled
- Thread.reportProgress(progress, message) - Report progress back to the main thread

### Options

### ThreadOptions
Options for creating a thread pool:

```typescript
const { ThreadPool } = require('threadmaster');

const pool = new ThreadPool({
  maxThreads: 4,              // Maximum number of threads (default: CPU count)
  autoTerminate: true,        // Automatically terminate workers (default: true)
  tempDir: './thread-temp',   // Directory for temporary files
  enableCaching: true         // Enable result caching (default: false)
});
```

### ThreadExecutionOptions
Options for executing a function in a thread:

```typescript
const options = {
  onProgress: (progress, message) => {
    console.log(`${progress}% - ${message}`);
  },
  timeout: 5000,              // Timeout in milliseconds
  priority: 'high',           // Priority: 'high', 'normal', 'low'
  retries: 3,                 // Number of retry attempts
  retryDelay: 1000            // Delay between retries in milliseconds
};
```

### ThreadPool Class
For more control, you can create and manage your own thread pool:

```typescript
const { ThreadPool } = require('threadmaster');

const pool = new ThreadPool({ maxThreads: 4 });

// Run a function in the pool
const result1 = await pool.run(fn1, data1).promise;
const result2 = await pool.run(fn2, data2).promise;

// Clean up when done
pool.cleanup();
```

### ThreadPool Methods

- run(fn, data, options) - Run a function in a thread
- runAll(fn, dataItems, options) - Run a function for multiple data items
- map(array, fn, options) - Map an array using a thread function
- batch(items, fn, batchSize, options) - Process array items in batches
- cleanup() - Clean up all resources
- clearCache() - Clear the result cache

### ThreadPool Properties

- activeThreadCount - Number of currently active threads
- queuedTaskCount - Number of tasks waiting in the queue

### Error Handling
The library provides custom error classes for different scenarios:

```typescript
const { run, ThreadError, ThreadTimeoutError } = require('threadmaster');

try {
  const result = await run(fn, data).promise;
} catch (error) {
  if (error instanceof ThreadTimeoutError) {
    console.log('Operation timed out');
  } else if (error instanceof ThreadError) {
    console.log('Thread error:', error.message);
    if (error.originalError) {
      console.log('Original error:', error.originalError);
    }
  } else {
    console.log('Unexpected error:', error);
  }
}
```

## Advanced Examples

### Retry Mechanism

```typescript
const { run } = require('threadmaster');

const result = await run(
  // Unreliable function
  () => {
    if (Math.random() < 0.7) {
      throw new Error('Random failure');
    }
    return 'Success!';
  },
  {},
  {
    retries: 5,
    retryDelay: 500
  }
).promise;
```

### Result Caching

```typescript
const { ThreadPool } = require('threadmaster');

const pool = new ThreadPool({ enableCaching: true });

// This will be computed
const result1 = await pool.run(
  (data) => {
    console.log('Computing...');
    return data.x * data.y;
  },
  { x: 10, y: 20 }
).promise;

// This will use cached result (no computation)
const result2 = await pool.run(
  (data) => {
    console.log('Computing...');
    return data.x * data.y;
  },
  { x: 10, y: 20 }
).promise;
```

### Processing Large Datasets

```typescript
const { batch } = require('threadmaster');

// Process 1 million items in batches
const items = Array.from({ length: 1000000 }, (_, i) => i);

const results = await batch(
  items,
  (batch) => {
    // Process each batch in a separate thread
    return batch.map(x => x * x);
  },
  10000, // 10,000 items per batch
  {
    onProgress: (progress) => {
      console.log(`Processing: ${progress.toFixed(2)}%`);
    }
  }
);
```
### Best Practices

- Thread Creation Overhead: Creating threads has overhead, so it's best for computationally intensive tasks rather than quick operations.
- Data Serialization: Data passed between threads is serialized/deserialized, which can be expensive for large objects.
- Error Handling: Always handle errors from thread operations, as they can fail in ways that synchronous code doesn't.
- Resource Cleanup: Call cleanup() when you're done with a thread pool to release resources.
- Cancellation: Design thread functions to check Thread.isCancelled() periodically for responsive cancellation.

## License

MIT

Made with by Michael Ilyash

