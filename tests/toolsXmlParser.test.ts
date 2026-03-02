import * as fs from 'fs';
import * as path from 'path';
import { parseToolsXml } from '../src/utils/toolsXmlParser';
import { buildToolsXml } from '../src/utils/toolsXmlWriter';
import { VALID_TOOL_APIS } from '../src/utils/config';

const DEFAULT_XML_PATH = path.join(__dirname, '../config/tools.default.xml');
const RUNTIME_XML_PATH = path.join(__dirname, '../config/tools.xml');

describe('parseToolsXml', () => {
  // ── Real file parsing ─────────────────────────────────────────

  describe('tools.default.xml', () => {
    const xmlContent = fs.readFileSync(DEFAULT_XML_PATH, 'utf-8');

    it('should parse without error', () => {
      expect(() => parseToolsXml(xmlContent)).not.toThrow();
    });

    it('should return all tools', () => {
      const tools = parseToolsXml(xmlContent);
      expect(tools.length).toBeGreaterThanOrEqual(10);
    });

    it('should have expected tool names', () => {
      const tools = parseToolsXml(xmlContent);
      const names = tools.map(t => t.name);
      expect(names).toContain('help');
      expect(names).toContain('activity_key');
      expect(names).toContain('generate_image');
      expect(names).toContain('generate_image_grok');
      expect(names).toContain('generate_video_grok');
      expect(names).toContain('get_current_weather');
      expect(names).toContain('web_search');
    });

    it('should parse xai-image and xai-video APIs', () => {
      const tools = parseToolsXml(xmlContent);
      const apis = tools.map(t => t.api);
      expect(apis).toContain('xai-image');
      expect(apis).toContain('xai-video');
    });

    it('should parse builtin flags correctly', () => {
      const tools = parseToolsXml(xmlContent);
      const help = tools.find(t => t.name === 'help');
      expect(help?.builtin).toBe(true);
      const weather = tools.find(t => t.name === 'get_current_weather');
      expect(weather?.builtin).toBeUndefined();
    });

    it('should parse parameters with mode, named params, and metadata', () => {
      const tools = parseToolsXml(xmlContent);
      const weather = tools.find(t => t.name === 'get_current_weather');
      expect(weather?.abilityInputs?.mode).toBe('explicit');
      expect(weather?.abilityInputs?.required).toEqual(['location']);
      expect(weather?.parameters?.location).toBeDefined();
      expect(weather?.parameters?.location.required).toBe(true);
    });

    it('should parse enabled=false on disabled tools', () => {
      const tools = parseToolsXml(xmlContent);
      const grokImage = tools.find(t => t.name === 'generate_image_grok');
      expect(grokImage?.enabled).toBe(false);
    });
  });

  describe('tools.xml (runtime)', () => {
    it('should parse without error if file exists', () => {
      if (!fs.existsSync(RUNTIME_XML_PATH)) return;
      const xmlContent = fs.readFileSync(RUNTIME_XML_PATH, 'utf-8');
      expect(() => parseToolsXml(xmlContent)).not.toThrow();
    });
  });

  // ── Round-trip fidelity ────────────────────────────────────────

  describe('round-trip', () => {
    it('should survive parse → build → parse without data loss', () => {
      const xmlContent = fs.readFileSync(DEFAULT_XML_PATH, 'utf-8');
      const first = parseToolsXml(xmlContent);
      const rebuilt = buildToolsXml(first);
      const second = parseToolsXml(rebuilt);

      expect(second).toHaveLength(first.length);
      for (let i = 0; i < first.length; i++) {
        expect(second[i].name).toBe(first[i].name);
        expect(second[i].api).toBe(first[i].api);
        expect(second[i].timeout).toBe(first[i].timeout);
        expect(second[i].description).toBe(first[i].description);
        expect(second[i].builtin).toBe(first[i].builtin);
        expect(second[i].enabled).toBe(first[i].enabled);
        expect(second[i].allowEmptyContent).toBe(first[i].allowEmptyContent);
        expect(second[i].abilityWhen).toBe(first[i].abilityWhen);
        if (first[i].abilityInputs) {
          expect(second[i].abilityInputs?.mode).toBe(first[i].abilityInputs?.mode);
          expect(second[i].abilityInputs?.required).toEqual(first[i].abilityInputs?.required);
          expect(second[i].abilityInputs?.optional).toEqual(first[i].abilityInputs?.optional);
        }
      }
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw on empty string', () => {
      expect(() => parseToolsXml('')).toThrow('Missing root <tools> element');
    });

    it('should throw on whitespace-only input', () => {
      expect(() => parseToolsXml('   \n  ')).toThrow('Missing root <tools> element');
    });

    it('should throw on wrong root element', () => {
      expect(() => parseToolsXml('<root><tool><name>x</name></tool></root>')).toThrow(
        'Missing root <tools> element',
      );
    });

    it('should throw on empty <tools> element (no <tool> children)', () => {
      // fast-xml-parser parses <tools></tools> as empty string, which is falsy
      expect(() => parseToolsXml('<tools></tools>')).toThrow();
    });

    it('should throw on malformed XML', () => {
      expect(() => parseToolsXml('<tools><tool><name>x</name>')).toThrow();
    });

    it('should throw on tool with missing name', () => {
      const xml = '<tools><tool><api>ollama</api><timeout>30</timeout><description>d</description></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('missing <name>');
    });

    it('should throw on tool with missing api', () => {
      const xml = '<tools><tool><name>x</name><timeout>30</timeout><description>d</description></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('invalid <api>');
    });

    it('should throw on tool with invalid api', () => {
      const xml = '<tools><tool><name>x</name><api>invalid</api><timeout>30</timeout><description>d</description></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('invalid <api>');
    });

    it('should throw on tool with missing timeout', () => {
      const xml = '<tools><tool><name>x</name><api>ollama</api><description>d</description></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('invalid <timeout>');
    });

    it('should throw on tool with missing description', () => {
      const xml = '<tools><tool><name>x</name><api>ollama</api><timeout>30</timeout></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('missing <description>');
    });
  });

  // ── Valid API values ───────────────────────────────────────────

  describe('valid APIs', () => {
    for (const api of VALID_TOOL_APIS) {
      it(`should accept api="${api}"`, () => {
        const xml = `<tools><tool><name>t</name><api>${api}</api><timeout>30</timeout><description>d</description></tool></tools>`;
        const tools = parseToolsXml(xml);
        expect(tools[0].api).toBe(api);
      });
    }
  });

  // ── Boolean parsing ────────────────────────────────────────────

  describe('boolean fields', () => {
    const wrap = (inner: string) =>
      `<tools><tool><name>t</name><api>ollama</api><timeout>30</timeout><description>d</description>${inner}</tool></tools>`;

    it('should parse builtin="true"', () => {
      const tools = parseToolsXml(wrap('<builtin>true</builtin>'));
      expect(tools[0].builtin).toBe(true);
    });

    it('should parse builtin="false"', () => {
      const tools = parseToolsXml(wrap('<builtin>false</builtin>'));
      expect(tools[0].builtin).toBe(false);
    });

    it('should parse enabled="false"', () => {
      const tools = parseToolsXml(wrap('<enabled>false</enabled>'));
      expect(tools[0].enabled).toBe(false);
    });

    it('should parse allowEmptyContent="true"', () => {
      const tools = parseToolsXml(wrap('<allowEmptyContent>true</allowEmptyContent>'));
      expect(tools[0].allowEmptyContent).toBe(true);
    });

    it('should throw on invalid boolean value', () => {
      expect(() => parseToolsXml(wrap('<builtin>yes</builtin>'))).toThrow('must be "true" or "false"');
    });
  });

  // ── Parameters parsing ─────────────────────────────────────────

  describe('parameters', () => {
    const wrap = (params: string) =>
      `<tools><tool><name>t</name><api>ollama</api><timeout>30</timeout><description>d</description><parameters>${params}</parameters></tool></tools>`;

    it('should parse mode', () => {
      const tools = parseToolsXml(wrap('<mode>explicit</mode><q><type>string</type><description>query</description><required>true</required></q>'));
      expect(tools[0].abilityInputs?.mode).toBe('explicit');
    });

    it('should throw on invalid mode', () => {
      expect(() => parseToolsXml(wrap('<mode>bad</mode>'))).toThrow('invalid <mode>');
    });

    it('should parse named parameters', () => {
      const xml = wrap(
        '<mode>explicit</mode>' +
        '<location><type>string</type><description>City name</description><required>true</required></location>' +
        '<format><type>string</type><description>Output format</description><required>false</required></format>',
      );
      const tools = parseToolsXml(xml);
      expect(tools[0].parameters?.location).toEqual({ type: 'string', description: 'City name', required: true });
      expect(tools[0].parameters?.format).toEqual({ type: 'string', description: 'Output format', required: false });
      expect(tools[0].abilityInputs?.required).toEqual(['location']);
      expect(tools[0].abilityInputs?.optional).toEqual(['format']);
    });

    it('should parse inferFrom', () => {
      const xml = wrap('<mode>implicit</mode><inferFrom>reply_target, current_message</inferFrom>');
      const tools = parseToolsXml(xml);
      expect(tools[0].abilityInputs?.inferFrom).toEqual(['reply_target', 'current_message']);
    });

    it('should parse validation', () => {
      const xml = wrap('<mode>explicit</mode><validation>Must be a city name.</validation>');
      const tools = parseToolsXml(xml);
      expect(tools[0].abilityInputs?.validation).toBe('Must be a city name.');
    });

    it('should parse examples', () => {
      const xml = wrap('<mode>implicit</mode><examples><example>test foo</example><example>test bar</example></examples>');
      const tools = parseToolsXml(xml);
      expect(tools[0].abilityInputs?.examples).toEqual(['test foo', 'test bar']);
    });
  });

  // ── Parser ↔ config constant sync ──────────────────────────────

  describe('VALID_TOOL_APIS sync', () => {
    it('parser should accept every API from VALID_TOOL_APIS', () => {
      // Ensures the parser's hardcoded list stays in sync with the canonical constant
      for (const api of VALID_TOOL_APIS) {
        const xml = `<tools><tool><name>t</name><api>${api}</api><timeout>30</timeout><description>d</description></tool></tools>`;
        expect(() => parseToolsXml(xml)).not.toThrow();
      }
    });

    it('parser should reject APIs not in VALID_TOOL_APIS', () => {
      const xml = '<tools><tool><name>t</name><api>nonexistent</api><timeout>30</timeout><description>d</description></tool></tools>';
      expect(() => parseToolsXml(xml)).toThrow('invalid <api>');
    });
  });

  // ── XML declaration handling ───────────────────────────────────

  describe('XML declaration', () => {
    const minXml = '<tools><tool><name>t</name><api>ollama</api><timeout>30</timeout><description>d</description></tool></tools>';

    it('should parse with XML declaration', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${minXml}`;
      expect(() => parseToolsXml(xml)).not.toThrow();
    });

    it('should parse without XML declaration', () => {
      expect(() => parseToolsXml(minXml)).not.toThrow();
    });
  });

  // ── Retry parsing ──────────────────────────────────────────────

  describe('retry', () => {
    const wrap = (retry: string) =>
      `<tools><tool><name>t</name><api>ollama</api><timeout>30</timeout><description>d</description><retry>${retry}</retry></tool></tools>`;

    it('should parse retry with all fields', () => {
      const tools = parseToolsXml(wrap('<enabled>true</enabled><maxRetries>3</maxRetries><model>llama3</model><prompt>try again</prompt>'));
      expect(tools[0].retry).toEqual({ enabled: true, maxRetries: 3, model: 'llama3', prompt: 'try again' });
    });

    it('should reject maxRetries > 10', () => {
      expect(() => parseToolsXml(wrap('<maxRetries>11</maxRetries>'))).toThrow('must be an integer between 0 and 10');
    });
  });
});
