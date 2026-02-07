/**
 * ComfyUIWebSocketManager tests — exercises WebSocket connection,
 * message handling, and execution waiting logic.
 * Uses WebSocket mocking; no real ComfyUI instance required.
 */

import { EventEmitter } from 'events';

// Create a mock WebSocket class that extends EventEmitter for event handling
class MockWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING initially
  
  constructor(_url: string) {
    super();
    // Simulate successful connection after a tick
    setImmediate(() => {
      this.readyState = 1; // OPEN
      this.emit('open');
    });
  }
  
  close() {
    this.readyState = 3; // CLOSED
    this.emit('close', 1000, Buffer.from('Normal closure'));
  }
  
  terminate() {
    this.readyState = 3; // CLOSED
  }
  
  // Helper to simulate receiving a message
  simulateMessage(data: string | Buffer | Buffer[]) {
    this.emit('message', data);
  }
  
  // Helper to simulate an error
  simulateError(error: Error) {
    this.emit('error', error);
  }
}

// Store instances for test manipulation
const mockInstances: MockWebSocket[] = [];

// Mock the ws module with static constants
const mockWsModule = jest.fn().mockImplementation((url: string) => {
  const instance = new MockWebSocket(url);
  mockInstances.push(instance);
  return instance;
}) as jest.Mock & { OPEN: number; CLOSED: number };

mockWsModule.OPEN = 1;
mockWsModule.CLOSED = 3;

jest.mock('ws', () => ({
  __esModule: true,
  default: mockWsModule,
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

import { ComfyUIWebSocketManager, ComfyUIWebSocketMessage } from '../src/api/comfyuiWebSocket';

describe('ComfyUIWebSocketManager', () => {
  let manager: ComfyUIWebSocketManager;
  
  beforeEach(() => {
    mockInstances.length = 0;
    manager = new ComfyUIWebSocketManager('http://localhost:8188', 'test-client-id');
  });
  
  afterEach(() => {
    manager.disconnect();
  });

  describe('connection management', () => {
    it('should convert HTTP URL to WebSocket URL', async () => {
      await manager.connect();
      
      expect(mockInstances.length).toBe(1);
      // The WebSocket constructor was called with ws:// URL
    });

    it('should report connected status after successful connection', async () => {
      expect(manager.isConnected()).toBe(false);
      
      await manager.connect();
      
      expect(manager.isConnected()).toBe(true);
    });

    it('should disconnect and clean up', async () => {
      await manager.connect();
      expect(manager.isConnected()).toBe(true);
      
      manager.disconnect();
      
      expect(manager.isConnected()).toBe(false);
    });

    it('should not create duplicate connections if already connected', async () => {
      await manager.connect();
      await manager.connect();
      
      // Should reuse existing connection
      expect(mockInstances.length).toBe(1);
    });

    it('should update base URL and disconnect existing connection', async () => {
      await manager.connect();
      expect(manager.isConnected()).toBe(true);
      
      manager.updateBaseUrl('http://newhost:8188');
      
      expect(manager.isConnected()).toBe(false);
    });
  });

  describe('message handling', () => {
    it('should parse and dispatch JSON messages to listeners', async () => {
      await manager.connect();
      
      const messages: ComfyUIWebSocketMessage[] = [];
      manager.addMessageListener((msg) => messages.push(msg));
      
      const testMessage: ComfyUIWebSocketMessage = {
        type: 'status',
        data: { queue_remaining: 0 },
      };
      
      mockInstances[0].simulateMessage(JSON.stringify(testMessage));
      
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('status');
      expect(messages[0].data.queue_remaining).toBe(0);
    });

    it('should ignore binary messages (preview images)', async () => {
      await manager.connect();
      
      const messages: ComfyUIWebSocketMessage[] = [];
      manager.addMessageListener((msg) => messages.push(msg));
      
      mockInstances[0].simulateMessage(Buffer.from([0x00, 0x01, 0x02]));
      
      expect(messages.length).toBe(0);
    });

    it('should ignore Buffer array messages', async () => {
      await manager.connect();
      
      const messages: ComfyUIWebSocketMessage[] = [];
      manager.addMessageListener((msg) => messages.push(msg));
      
      // Simulate a Buffer[] (which ws can produce with certain options)
      mockInstances[0].simulateMessage([Buffer.from([0x00]), Buffer.from([0x01])]);
      
      expect(messages.length).toBe(0);
    });

    it('should allow removing message listeners', async () => {
      await manager.connect();
      
      const messages: ComfyUIWebSocketMessage[] = [];
      const removeListener = manager.addMessageListener((msg) => messages.push(msg));
      
      removeListener();
      
      mockInstances[0].simulateMessage(JSON.stringify({ type: 'status', data: {} }));
      
      expect(messages.length).toBe(0);
    });
  });

  describe('waitForExecution', () => {
    it('should resolve successfully when execution completes', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
      });
      
      // Simulate execution starting
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: '5' },
      }));
      
      // Simulate execution completing (node: null)
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: null },
      }));
      
      const result = await resultPromise;
      
      expect(result.success).toBe(true);
      expect(result.completed).toBe(true);
      expect(result.promptId).toBe('test-prompt-123');
    });

    it('should resolve with error on execution_error message', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
      });
      
      // Simulate execution error
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'execution_error',
        data: {
          prompt_id: 'test-prompt-123',
          node_id: '5',
          node_type: 'KSampler',
          exception_message: 'Model not found',
        },
      }));
      
      const result = await resultPromise;
      
      expect(result.success).toBe(false);
      expect(result.completed).toBe(true);
      expect(result.error).toContain('Model not found');
      expect(result.error).toContain('KSampler');
    });

    it('should ignore messages for other prompts', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'my-prompt',
        timeoutMs: 5000,
      });
      
      // Message for a different prompt - should be ignored
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'other-prompt', node: null },
      }));
      
      // Now complete our prompt
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'my-prompt', node: null },
      }));
      
      const result = await resultPromise;
      
      expect(result.success).toBe(true);
      expect(result.promptId).toBe('my-prompt');
    });

    it('should call onProgress callback for progress messages', async () => {
      await manager.connect();
      
      const progressUpdates: { value: number; max: number; nodeId: string }[] = [];
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
        onProgress: (value, max, nodeId) => {
          progressUpdates.push({ value, max, nodeId });
        },
      });
      
      // Simulate progress updates
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'progress',
        data: { prompt_id: 'test-prompt-123', value: 5, max: 20, node: 'sampler' },
      }));
      
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'progress',
        data: { prompt_id: 'test-prompt-123', value: 10, max: 20, node: 'sampler' },
      }));
      
      // Complete execution
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: null },
      }));
      
      await resultPromise;
      
      expect(progressUpdates.length).toBe(2);
      expect(progressUpdates[0]).toEqual({ value: 5, max: 20, nodeId: 'sampler' });
      expect(progressUpdates[1]).toEqual({ value: 10, max: 20, nodeId: 'sampler' });
    });

    it('should call onExecuting callback for node changes', async () => {
      await manager.connect();
      
      const executingNodes: (string | null)[] = [];
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
        onExecuting: (nodeId) => {
          executingNodes.push(nodeId);
        },
      });
      
      // Simulate node execution sequence
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: 'loader' },
      }));
      
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: 'sampler' },
      }));
      
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: null },
      }));
      
      await resultPromise;
      
      expect(executingNodes).toEqual(['loader', 'sampler', null]);
    });

    it('should timeout if execution takes too long', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 100, // Very short timeout for testing
      });
      
      // Don't send completion message - let it timeout
      const result = await resultPromise;
      
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should handle abort signal', async () => {
      await manager.connect();
      
      const controller = new AbortController();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
        signal: controller.signal,
      });
      
      // Abort immediately
      controller.abort();
      
      const result = await resultPromise;
      
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error).toContain('aborted');
    });

    it('should return error if already aborted', async () => {
      await manager.connect();
      
      const controller = new AbortController();
      controller.abort(); // Pre-abort
      
      const result = await manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
        signal: controller.signal,
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });

    it('should fail fast when WebSocket closes during wait', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
      });
      
      // Simulate WebSocket closing unexpectedly
      mockInstances[0].emit('close', 1006, Buffer.from('Abnormal closure'));
      
      const result = await resultPromise;
      
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error).toContain('WebSocket connection closed');
    });

    it('should fail fast when WebSocket errors during wait', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
      });
      
      // Simulate WebSocket error
      mockInstances[0].emit('error', new Error('Connection reset'));
      
      const result = await resultPromise;
      
      expect(result.success).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error).toContain('WebSocket error during execution');
      expect(result.error).toContain('Connection reset');
    });

    it('should not forward progress for messages without prompt_id', async () => {
      await manager.connect();
      
      const progressUpdates: { value: number; max: number; nodeId: string }[] = [];
      
      const resultPromise = manager.waitForExecution({
        promptId: 'my-prompt',
        timeoutMs: 5000,
        onProgress: (value, max, nodeId) => {
          progressUpdates.push({ value, max, nodeId });
        },
      });
      
      // Progress without prompt_id — should be filtered out
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'progress',
        data: { value: 5, max: 20, node: 'sampler' },
      }));
      
      // Progress with matching prompt_id — should be forwarded
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'progress',
        data: { prompt_id: 'my-prompt', value: 10, max: 20, node: 'sampler' },
      }));
      
      // Complete execution
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'my-prompt', node: null },
      }));
      
      await resultPromise;
      
      expect(progressUpdates.length).toBe(1);
      expect(progressUpdates[0]).toEqual({ value: 10, max: 20, nodeId: 'sampler' });
    });

    it('should not call onExecuting for messages without prompt_id', async () => {
      await manager.connect();
      
      const executingNodes: (string | null)[] = [];
      
      const resultPromise = manager.waitForExecution({
        promptId: 'my-prompt',
        timeoutMs: 5000,
        onExecuting: (nodeId) => {
          executingNodes.push(nodeId);
        },
      });
      
      // Executing without prompt_id — should NOT call onExecuting
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { node: 'some-node' },
      }));
      
      // Executing with matching prompt_id — should call onExecuting
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'my-prompt', node: 'loader' },
      }));
      
      // Complete execution
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'my-prompt', node: null },
      }));
      
      await resultPromise;
      
      // Only the two messages with matching prompt_id should have called onExecuting
      expect(executingNodes).toEqual(['loader', null]);
    });

    it('should populate elapsedMs in execution result', async () => {
      await manager.connect();
      
      const resultPromise = manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 5000,
      });
      
      // Complete immediately
      mockInstances[0].simulateMessage(JSON.stringify({
        type: 'executing',
        data: { prompt_id: 'test-prompt-123', node: null },
      }));
      
      const result = await resultPromise;
      
      expect(result.elapsedMs).toBeDefined();
      expect(typeof result.elapsedMs).toBe('number');
      expect(result.elapsedMs! >= 0).toBe(true);
    });

    it('should populate elapsedMs on timeout', async () => {
      await manager.connect();
      
      const result = await manager.waitForExecution({
        promptId: 'test-prompt-123',
        timeoutMs: 50, // Very short
      });
      
      expect(result.success).toBe(false);
      expect(result.elapsedMs).toBeDefined();
      expect(result.elapsedMs!).toBeGreaterThanOrEqual(40); // approximately 50ms
    });
  });
});
