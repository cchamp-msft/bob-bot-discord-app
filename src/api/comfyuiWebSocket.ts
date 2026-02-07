import WebSocket from 'ws';
import { logger } from '../utils/logger';

/**
 * WebSocket message types from ComfyUI server.
 */
export type ComfyUIMessageType =
  | 'status'
  | 'executing'
  | 'progress'
  | 'executed'
  | 'execution_error'
  | 'execution_cached'
  | 'execution_start'
  | 'progress_state';

/**
 * Message structure received from ComfyUI WebSocket.
 */
export interface ComfyUIWebSocketMessage {
  type: ComfyUIMessageType;
  data: Record<string, unknown>;
}

/**
 * Execution result from waiting on WebSocket.
 */
export interface ExecutionResult {
  success: boolean;
  promptId: string;
  error?: string;
  /** Set to true when execution completed normally. */
  completed: boolean;
  /** Milliseconds elapsed from the start of the wait until resolution. */
  elapsedMs?: number;
}

/**
 * Options for waiting on prompt execution.
 */
export interface WaitForExecutionOptions {
  promptId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (value: number, max: number, nodeId: string) => void;
  onExecuting?: (nodeId: string | null) => void;
}

/**
 * ComfyUI WebSocket connection manager.
 *
 * Establishes and maintains a WebSocket connection to ComfyUI server
 * for real-time execution tracking (vs polling /history).
 */
export class ComfyUIWebSocketManager {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private clientId: string;
  private messageListeners: Set<(msg: ComfyUIWebSocketMessage) => void> = new Set();
  private connectionPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private static MAX_RECONNECT_ATTEMPTS = 3;
  private static RECONNECT_DELAY_MS = 1000;

  constructor(baseUrl: string, clientId: string) {
    // Convert HTTP URL to WebSocket URL
    this.baseUrl = baseUrl.replace(/^http/, 'ws');
    this.clientId = clientId;
  }

  /**
   * Update the base URL (called after config refresh).
   */
  updateBaseUrl(newBaseUrl: string): void {
    const wasConnected = this.isConnected();
    if (wasConnected) {
      this.disconnect();
    }
    this.baseUrl = newBaseUrl.replace(/^http/, 'ws');
  }

  /**
   * Update the client ID.
   */
  updateClientId(newClientId: string): void {
    const wasConnected = this.isConnected();
    if (wasConnected) {
      this.disconnect();
    }
    this.clientId = newClientId;
  }

  /**
   * Check if WebSocket is currently connected.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to ComfyUI WebSocket server.
   * Returns immediately if already connected.
   */
  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    // If connection is in progress, wait for it
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.baseUrl}/ws?clientId=${encodeURIComponent(this.clientId)}`;
      logger.log('success', 'comfyui-ws', `Connecting to WebSocket: ${wsUrl}`);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.logError('comfyui-ws', `Failed to create WebSocket: ${errorMsg}`);
        reject(new Error(`Failed to create WebSocket: ${errorMsg}`));
        return;
      }

      const connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.terminate();
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000); // 10 second connection timeout

      this.ws.on('open', () => {
        clearTimeout(connectionTimeout);
        this.reconnectAttempts = 0;
        logger.log('success', 'comfyui-ws', 'WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        this.handleMessage(data, isBinary);
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectionTimeout);
        logger.logError('comfyui-ws', `WebSocket error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        logger.log('success', 'comfyui-ws', `WebSocket closed: ${code} - ${reason.toString()}`);
        this.ws = null;
      });
    });
  }

  /**
   * Disconnect from WebSocket server.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageListeners.clear();
  }

  /**
   * Handle incoming WebSocket messages.
   * In ws v8+, `isBinary` reliably indicates whether the frame is binary.
   * All data arrives as Buffer — we must NOT filter on Buffer.isBuffer()
   * because that would drop text (JSON) messages too.
   */
  private handleMessage(data: WebSocket.Data, isBinary: boolean): void {
    // Binary frames = preview images, skip
    if (isBinary) {
      return;
    }

    try {
      const message = JSON.parse(data.toString()) as ComfyUIWebSocketMessage;
      
      // Notify all listeners
      for (const listener of this.messageListeners) {
        try {
          listener(message);
        } catch (err) {
          logger.logError('comfyui-ws', `Message listener error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      logger.logError('comfyui-ws', `Failed to parse WebSocket message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Add a message listener.
   */
  addMessageListener(listener: (msg: ComfyUIWebSocketMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /**
   * Wait for a specific prompt to complete execution.
   *
   * Listens for ComfyUI WebSocket messages and resolves when:
   * - "executing" message with node=null for our prompt_id (success)
   * - "execution_error" message for our prompt_id (failure)
   * - Timeout expires
   * - AbortSignal is triggered
   */
  async waitForExecution(options: WaitForExecutionOptions): Promise<ExecutionResult> {
    const { promptId, timeoutMs, signal, onProgress, onExecuting } = options;

    // Ensure we're connected
    if (!this.isConnected()) {
      try {
        await this.connectWithRetry();
      } catch (err) {
        return {
          success: false,
          promptId,
          completed: false,
          error: `Failed to connect to ComfyUI WebSocket: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return new Promise<ExecutionResult>((resolve) => {
      let resolved = false;
      let timeoutId: NodeJS.Timeout | undefined;
      let removeMessageListener: (() => void) | null = null;
      const startTime = Date.now();
      // Capture active ws instance so cleanup always targets the correct socket
      const capturedWs = this.ws;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (removeMessageListener) {
          removeMessageListener();
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        if (capturedWs) {
          capturedWs.removeListener('close', onWsClose);
          capturedWs.removeListener('error', onWsError);
        }
      };

      const resolveOnce = (result: ExecutionResult) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ ...result, elapsedMs: Date.now() - startTime });
        }
      };

      // Listen for WebSocket close/error during wait — fail fast
      const onWsClose = () => {
        resolveOnce({
          success: false,
          promptId,
          completed: false,
          error: 'WebSocket connection closed during execution',
        });
      };

      const onWsError = (err: Error) => {
        resolveOnce({
          success: false,
          promptId,
          completed: false,
          error: `WebSocket error during execution: ${err.message}`,
        });
      };

      // Handle abort signal
      const onAbort = () => {
        resolveOnce({
          success: false,
          promptId,
          completed: false,
          error: 'Execution aborted',
        });
      };

      if (capturedWs) {
        capturedWs.on('close', onWsClose);
        capturedWs.on('error', onWsError);
      }

      if (signal) {
        if (signal.aborted) {
          resolveOnce({
            success: false,
            promptId,
            completed: false,
            error: 'Execution aborted',
          });
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      // Set up timeout
      timeoutId = setTimeout(() => {
        resolveOnce({
          success: false,
          promptId,
          completed: false,
          error: 'Execution timed out waiting for ComfyUI',
        });
      }, timeoutMs);

      // Listen for messages
      removeMessageListener = this.addMessageListener((msg) => {
        const msgPromptId = msg.data.prompt_id as string | undefined;

        // Debug: log all messages for our prompt
        if (msgPromptId === promptId || !msgPromptId) {
          logger.log('success', 'comfyui-ws', `Message received: type=${msg.type}, promptId=${msgPromptId || 'none'}, data keys=[${Object.keys(msg.data).join(', ')}]`);
        }

        // Only process messages for our prompt — strict matching
        // Skip messages from other prompts
        if (msgPromptId && msgPromptId !== promptId) {
          return;
        }

        switch (msg.type) {
          case 'executing': {
            const nodeId = msg.data.node as string | null;
            // Only call onExecuting when prompt_id matches (strict filtering)
            if (msgPromptId === promptId) {
              if (onExecuting) {
                onExecuting(nodeId);
              }
              // node === null means execution is complete
              if (nodeId === null) {
                resolveOnce({
                  success: true,
                  promptId,
                  completed: true,
                });
              }
            }
            break;
          }

          case 'progress': {
            // Only forward progress for our prompt (require prompt_id)
            if (msgPromptId === promptId && onProgress) {
              const value = msg.data.value as number;
              const max = msg.data.max as number;
              const nodeId = msg.data.node as string;
              onProgress(value, max, nodeId);
            }
            break;
          }

          case 'execution_error': {
            // Only handle errors for our prompt (require prompt_id)
            if (msgPromptId !== promptId) {
              return;
            }
            const errorData = msg.data;
            const nodeType = errorData.node_type as string | undefined;
            const nodeId = errorData.node_id as string | undefined;
            const exceptionMessage = errorData.exception_message as string | undefined;
            const exceptionType = errorData.exception_type as string | undefined;

            const errorParts: string[] = ['ComfyUI execution error'];
            if (nodeId) errorParts.push(`[node ${nodeId}]`);
            if (nodeType) errorParts.push(`(${nodeType})`);
            errorParts.push(':');
            errorParts.push(exceptionMessage || exceptionType || 'Unknown error');

            resolveOnce({
              success: false,
              promptId,
              completed: true,
              error: errorParts.join(' '),
            });
            break;
          }

          case 'execution_start': {
            if (msgPromptId === promptId) {
              logger.log('success', 'comfyui-ws', `Execution started for prompt ${promptId}`);
            }
            break;
          }

          case 'executed': {
            // Node execution completed with output data
            // This is sent when a node finishes executing (not the same as 'executing' with null node)
            if (msgPromptId === promptId) {
              const nodeId = msg.data.node as string | undefined;
              const output = msg.data.output as Record<string, unknown> | undefined;
              logger.log('success', 'comfyui-ws', `Node executed: ${nodeId}, output keys=[${output ? Object.keys(output).join(', ') : 'none'}]`);
            }
            break;
          }

          case 'execution_cached': {
            // Node execution was cached (skipped)
            if (msgPromptId === promptId) {
              const nodes = msg.data.nodes as string[] | undefined;
              logger.log('success', 'comfyui-ws', `Execution cached for nodes: [${nodes?.join(', ') || 'none'}]`);
            }
            break;
          }

          case 'status': {
            // Queue status updates - we can log but don't need to act on them
            break;
          }
        }
      });
    });
  }

  /**
   * Connect with retry logic.
   */
  async connectWithRetry(): Promise<void> {
    while (this.reconnectAttempts < ComfyUIWebSocketManager.MAX_RECONNECT_ATTEMPTS) {
      try {
        await this.connect();
        return;
      } catch (err) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= ComfyUIWebSocketManager.MAX_RECONNECT_ATTEMPTS) {
          throw err;
        }
        logger.log(
          'success',
          'comfyui-ws',
          `Reconnect attempt ${this.reconnectAttempts}/${ComfyUIWebSocketManager.MAX_RECONNECT_ATTEMPTS}`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, ComfyUIWebSocketManager.RECONNECT_DELAY_MS * this.reconnectAttempts)
        );
      }
    }
  }
}
