/**
 * ResponseTransformer tests — exercises result extraction and
 * final-pass prompt building for the API routing pipeline.
 */

import {
  extractFromComfyUI,
  extractFromOllama,
  extractFromMeme,
  extractStageResult,
  buildFinalPassPrompt,
  StageResult,
} from '../src/utils/responseTransformer';
import { ComfyUIResponse } from '../src/api/comfyuiClient';
import { OllamaResponse } from '../src/api/ollamaClient';
import { MemeResponse } from '../src/types';

describe('ResponseTransformer', () => {
  describe('extractFromComfyUI', () => {
    it('should extract images from a successful ComfyUI response', () => {
      const response: ComfyUIResponse = {
        success: true,
        data: {
          images: ['http://example.com/img1.png', 'http://example.com/img2.png'],
        },
      };

      const result = extractFromComfyUI(response);

      expect(result.sourceApi).toBe('comfyui');
      expect(result.images).toEqual(['http://example.com/img1.png', 'http://example.com/img2.png']);
      expect(result.text).toContain('2 image(s)');
      expect(result.rawResponse).toBe(response);
    });

    it('should use text field if present in ComfyUI response', () => {
      const response: ComfyUIResponse = {
        success: true,
        data: {
          text: 'Custom text output',
          images: ['http://example.com/img1.png'],
        },
      };

      const result = extractFromComfyUI(response);

      expect(result.text).toBe('Custom text output');
      expect(result.images).toEqual(['http://example.com/img1.png']);
    });

    it('should handle response with no images', () => {
      const response: ComfyUIResponse = {
        success: true,
        data: { images: [] },
      };

      const result = extractFromComfyUI(response);

      expect(result.images).toBeUndefined();
      expect(result.text).toBeUndefined();
    });

    it('should handle response with no data', () => {
      const response: ComfyUIResponse = {
        success: false,
        error: 'Something failed',
      };

      const result = extractFromComfyUI(response);

      expect(result.images).toBeUndefined();
      expect(result.text).toBeUndefined();
    });
  });

  describe('extractFromOllama', () => {
    it('should extract text from a successful Ollama response', () => {
      const response: OllamaResponse = {
        success: true,
        data: { text: 'Hello, I am a bot!' },
      };

      const result = extractFromOllama(response);

      expect(result.sourceApi).toBe('ollama');
      expect(result.text).toBe('Hello, I am a bot!');
      expect(result.rawResponse).toBe(response);
    });

    it('should handle response with no data', () => {
      const response: OllamaResponse = {
        success: false,
        error: 'Model not found',
      };

      const result = extractFromOllama(response);

      expect(result.text).toBeUndefined();
    });
  });

  describe('extractFromMeme', () => {
    it('should extract text and imageUrl from a successful Meme response', () => {
      const response: MemeResponse = {
        success: true,
        data: {
          text: 'One does not simply walk into Mordor',
          imageUrl: 'https://api.memegen.link/images/mordor.png',
        },
      };

      const result = extractFromMeme(response);

      expect(result.sourceApi).toBe('meme');
      expect(result.text).toBe('One does not simply walk into Mordor');
      expect(result.images).toEqual(['https://api.memegen.link/images/mordor.png']);
      expect(result.rawResponse).toBe(response);
    });

    it('should handle response with no data', () => {
      const response: MemeResponse = {
        success: false,
        error: 'Template not found',
      };

      const result = extractFromMeme(response);

      expect(result.text).toBeUndefined();
      expect(result.images).toBeUndefined();
    });

    it('should handle response with text but no imageUrl', () => {
      const response: MemeResponse = {
        success: true,
        data: { text: 'Some meme text' },
      };

      const result = extractFromMeme(response);

      expect(result.text).toBe('Some meme text');
      expect(result.images).toBeUndefined();
    });
  });

  describe('extractStageResult', () => {
    it('should dispatch to ComfyUI extractor for comfyui api', () => {
      const response: ComfyUIResponse = {
        success: true,
        data: { images: ['http://example.com/img.png'] },
      };

      const result = extractStageResult('comfyui', response);

      expect(result.sourceApi).toBe('comfyui');
      expect(result.images).toHaveLength(1);
    });

    it('should dispatch to Ollama extractor for ollama api', () => {
      const response: OllamaResponse = {
        success: true,
        data: { text: 'Test response' },
      };

      const result = extractStageResult('ollama', response);

      expect(result.sourceApi).toBe('ollama');
      expect(result.text).toBe('Test response');
    });

    it('should dispatch to Meme extractor for meme api', () => {
      const response: MemeResponse = {
        success: true,
        data: {
          text: 'Meme text here',
          imageUrl: 'https://api.memegen.link/images/test.png',
        },
      };

      const result = extractStageResult('meme', response);

      expect(result.sourceApi).toBe('meme');
      expect(result.text).toBe('Meme text here');
      expect(result.images).toEqual(['https://api.memegen.link/images/test.png']);
    });
  });

  describe('buildFinalPassPrompt', () => {
    it('should build prompt with ComfyUI image context', () => {
      const stageResult: StageResult = {
        sourceApi: 'comfyui',
        images: ['http://example.com/img.png'],
        text: '[Generated 1 image(s): http://example.com/img.png]',
        rawResponse: { success: true, data: { images: ['http://example.com/img.png'] } },
      };

      const prompt = buildFinalPassPrompt('draw a sunset', stageResult);

      expect(prompt).toContain('generated 1 image(s)');
      expect(prompt).toContain('http://example.com/img.png');
      expect(prompt).toContain('draw a sunset');
      expect(prompt).toContain('conversational response');
    });

    it('should build prompt with Ollama text context', () => {
      const stageResult: StageResult = {
        sourceApi: 'ollama',
        text: 'The sky is blue because of Rayleigh scattering.',
        rawResponse: { success: true, data: { text: 'The sky is blue because of Rayleigh scattering.' } },
      };

      const prompt = buildFinalPassPrompt('why is the sky blue?', stageResult);

      expect(prompt).toContain('Previous analysis result');
      expect(prompt).toContain('Rayleigh scattering');
      expect(prompt).toContain('why is the sky blue?');
    });

    it('should handle ComfyUI result with no images', () => {
      const stageResult: StageResult = {
        sourceApi: 'comfyui',
        rawResponse: { success: true, data: { images: [] } },
      };

      const prompt = buildFinalPassPrompt('draw something', stageResult);

      expect(prompt).toContain('draw something');
      expect(prompt).not.toContain('generated');
    });

    it('should not duplicate generated-text marker in prompt', () => {
      const stageResult: StageResult = {
        sourceApi: 'comfyui',
        images: ['http://example.com/img.png'],
        text: '[Generated 1 image(s): http://example.com/img.png]',
        rawResponse: { success: true, data: { images: ['http://example.com/img.png'] } },
      };

      const prompt = buildFinalPassPrompt('test', stageResult);

      // The auto-generated text marker should not appear as "Additional output"
      expect(prompt).not.toContain('Additional output: [Generated');
    });
  });
});
