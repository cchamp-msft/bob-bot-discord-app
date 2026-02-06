/** A single message in a conversation chain for Ollama chat context. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
