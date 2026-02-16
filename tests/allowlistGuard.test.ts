/**
 * Allowlist guard tests — CIDR and single-IP parsing used when
 * CONFIGURATOR_ALLOW_REMOTE is true (e.g. Docker).
 */

import { ipv4InCidr } from '../src/utils/httpServer';

describe('ipv4InCidr', () => {
  it('matches exact single IPv4', () => {
    expect(ipv4InCidr('192.168.1.1', '192.168.1.1')).toBe(true);
    expect(ipv4InCidr('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(ipv4InCidr('192.168.1.1', '192.168.1.2')).toBe(false);
  });

  it('matches IPv4-mapped form (::ffff:x.x.x.x)', () => {
    expect(ipv4InCidr('::ffff:172.17.0.1', '172.17.0.1')).toBe(true);
    expect(ipv4InCidr('::ffff:172.17.0.1', '172.17.0.0/16')).toBe(true);
  });

  it('matches /32 CIDR as single host', () => {
    expect(ipv4InCidr('192.168.1.1', '192.168.1.1/32')).toBe(true);
    expect(ipv4InCidr('192.168.1.2', '192.168.1.1/32')).toBe(false);
  });

  it('matches /24 CIDR', () => {
    expect(ipv4InCidr('192.168.1.0', '192.168.1.0/24')).toBe(true);
    expect(ipv4InCidr('192.168.1.255', '192.168.1.0/24')).toBe(true);
    expect(ipv4InCidr('192.168.2.0', '192.168.1.0/24')).toBe(false);
  });

  it('matches /16 CIDR (Docker bridge)', () => {
    expect(ipv4InCidr('172.17.0.1', '172.17.0.0/16')).toBe(true);
    expect(ipv4InCidr('172.17.255.255', '172.17.0.0/16')).toBe(true);
    expect(ipv4InCidr('172.18.0.1', '172.17.0.0/16')).toBe(false);
  });

  it('returns false for invalid IP', () => {
    expect(ipv4InCidr('256.1.1.1', '256.1.1.1')).toBe(false);
    expect(ipv4InCidr('not-an-ip', '192.168.1.0/24')).toBe(false);
    expect(ipv4InCidr('192.168.1', '192.168.1.0/24')).toBe(false);
  });

  it('returns false for invalid CIDR', () => {
    expect(ipv4InCidr('192.168.1.1', '192.168.1.0/33')).toBe(false);
    expect(ipv4InCidr('192.168.1.1', '192.168.1.0/-1')).toBe(false);
  });
});
