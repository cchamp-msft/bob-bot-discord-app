/** A single message in a conversation chain for Ollama chat context. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Safe (no secrets) config snapshot returned by GET /api/config. */
export interface PublicConfig {
  discord: {
    clientId: string;
    tokenConfigured: boolean;
  };
  apis: {
    comfyui: string;
    ollama: string;
    ollamaModel: string;
    ollamaSystemPrompt: string;
    comfyuiWorkflowConfigured: boolean;
  };
  defaultWorkflow: {
    model: string;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    denoise: number;
  };
  errorHandling: {
    errorMessage: string;
    errorRateLimitMinutes: number;
  };
  http: {
    port: number;
    outputBaseUrl: string;
  };
  limits: {
    fileSizeThreshold: number;
    defaultTimeout: number;
    maxAttachments: number;
  };
  keywords: import('./utils/config').KeywordConfig[];
  replyChain: {
    enabled: boolean;
    maxDepth: number;
    maxTokens: number;
  };
  imageResponse: {
    includeEmbed: boolean;
  };
}
