/**
 * Docker hardening regression tests — verifies that the Dockerfile and
 * docker-compose.yml maintain the expected security posture:
 *   - Non-root USER in Dockerfile
 *   - Digest-pinned base image
 *   - read_only, cap_drop ALL, no-new-privileges in compose
 *   - Outputs port bound to localhost (reverse-proxy model)
 *   - No .env bind-mount (secrets via env_file only)
 *
 * These tests parse the static files so they run without Docker.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
const composefile = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf-8');

describe('Dockerfile hardening', () => {
  it('pins base images by digest (@sha256:)', () => {
    const fromLines = dockerfile.match(/^FROM\s+.+$/gm) || [];
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });

  it('creates a non-root user', () => {
    expect(dockerfile).toMatch(/adduser\s/);
  });

  it('switches to non-root USER before CMD', () => {
    const userIdx = dockerfile.lastIndexOf('USER ');
    const cmdIdx = dockerfile.lastIndexOf('CMD ');
    expect(userIdx).toBeGreaterThan(-1);
    expect(cmdIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(cmdIdx);
  });

  it('does not run as root (no USER root after final USER)', () => {
    const lines = dockerfile.split('\n');
    let lastUser = '';
    for (const line of lines) {
      const m = line.match(/^\s*USER\s+(\S+)/);
      if (m) lastUser = m[1];
    }
    expect(lastUser).not.toBe('root');
    expect(lastUser).not.toBe('0');
    expect(lastUser.length).toBeGreaterThan(0);
  });

  it('includes a HEALTHCHECK', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
  });
});

describe('docker-compose.yml hardening', () => {
  it('enables read_only root filesystem', () => {
    expect(composefile).toMatch(/read_only:\s*true/);
  });

  it('drops ALL Linux capabilities', () => {
    expect(composefile).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
  });

  it('enables no-new-privileges', () => {
    expect(composefile).toMatch(/no-new-privileges:\s*true/);
  });

  it('specifies a non-root user', () => {
    expect(composefile).toMatch(/user:\s*["']?(?!root|0\b)/);
  });

  it('binds outputs port (3003) to localhost only', () => {
    // Expect "127.0.0.1:3003:3003" not bare "3003:3003"
    const portLines = composefile.match(/["']?[\d.:]+:3003["']?/g) || [];
    expect(portLines.length).toBeGreaterThan(0);
    for (const p of portLines) {
      expect(p).toMatch(/127\.0\.0\.1/);
    }
  });

  it('does not bind-mount .env file into container', () => {
    // env_file is fine; a volumes entry mapping .env is not
    const volumeSection = composefile.match(/volumes:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (volumeSection) {
      const entries = volumeSection[1];
      expect(entries).not.toMatch(/\.env:\/app\/\.env/);
    }
  });

  it('uses env_file for secrets injection', () => {
    expect(composefile).toMatch(/env_file:\s*.+\.env/);
  });

  it('includes tmpfs for /tmp', () => {
    expect(composefile).toMatch(/tmpfs:/);
    expect(composefile).toMatch(/\/tmp/);
  });
});
