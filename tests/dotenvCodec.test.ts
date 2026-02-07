import { decodeDotenvEscapes, readEnvVarFromString } from '../src/utils/dotenvCodec';

describe('dotenvCodec', () => {
  describe('decodeDotenvEscapes', () => {
    it('should decode escaped double quotes', () => {
      expect(decodeDotenvEscapes('say \\"hello\\" world')).toBe('say "hello" world');
    });

    it('should decode escaped backslashes', () => {
      expect(decodeDotenvEscapes('path\\\\to\\\\file')).toBe('path\\to\\file');
    });

    it('should decode escaped newlines', () => {
      expect(decodeDotenvEscapes('line1\\nline2')).toBe('line1\nline2');
    });

    it('should decode escaped carriage returns', () => {
      expect(decodeDotenvEscapes('a\\rb')).toBe('a\rb');
    });

    it('should preserve unknown escape sequences literally', () => {
      expect(decodeDotenvEscapes('\\t stays')).toBe('\\t stays');
    });

    it('should handle mixed escapes', () => {
      const input = 'say \\"hello\\"\\nand \\\\goodbye';
      expect(decodeDotenvEscapes(input)).toBe('say "hello"\nand \\goodbye');
    });

    it('should handle empty string', () => {
      expect(decodeDotenvEscapes('')).toBe('');
    });

    it('should handle trailing backslash', () => {
      expect(decodeDotenvEscapes('end\\')).toBe('end\\');
    });
  });

  describe('readEnvVarFromString', () => {
    it('should read an unquoted value', () => {
      expect(readEnvVarFromString('FOO=bar', 'FOO')).toBe('bar');
    });

    it('should return undefined for missing key', () => {
      expect(readEnvVarFromString('FOO=bar', 'BAZ')).toBeUndefined();
    });

    it('should skip comments', () => {
      const content = '# comment\nFOO=bar';
      expect(readEnvVarFromString(content, 'FOO')).toBe('bar');
    });

    it('should decode a double-quoted value with escapes', () => {
      const content = 'MSG="say \\"hello\\" world"';
      expect(readEnvVarFromString(content, 'MSG')).toBe('say "hello" world');
    });

    it('should decode escaped backslashes inside double quotes', () => {
      const content = 'PATH="C:\\\\Users\\\\me"';
      expect(readEnvVarFromString(content, 'PATH')).toBe('C:\\Users\\me');
    });

    it('should decode \\n as newline inside double quotes', () => {
      const content = 'PROMPT="line1\\nline2"';
      expect(readEnvVarFromString(content, 'PROMPT')).toBe('line1\nline2');
    });

    it('should return single-quoted value verbatim (no escape processing)', () => {
      const content = "MSG='say \\\"hello\\\"'";
      expect(readEnvVarFromString(content, 'MSG')).toBe('say \\"hello\\"');
    });

    it('should return empty string for empty unquoted value', () => {
      expect(readEnvVarFromString('FOO=', 'FOO')).toBe('');
    });

    it('should return empty string for empty double-quoted value', () => {
      expect(readEnvVarFromString('FOO=""', 'FOO')).toBe('');
    });

    it('should handle value with equals sign', () => {
      expect(readEnvVarFromString('FOO=a=b=c', 'FOO')).toBe('a=b=c');
    });

    it('should return undefined for empty content', () => {
      expect(readEnvVarFromString('', 'FOO')).toBeUndefined();
    });
  });
});
