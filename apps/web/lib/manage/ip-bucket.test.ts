import { describe, expect, it } from 'vitest';
import { ipBucket } from './ip-bucket';

describe('ipBucket (A-141)', () => {
  it('leaves IPv4 alone', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('puts every address in one /64 in one bucket, whatever the spelling', () => {
    const bucket = '2001:db8:85a3:1::/64';
    expect(ipBucket('2001:db8:85a3:1::1')).toBe(bucket);
    expect(ipBucket('2001:0DB8:85a3:0001:ffff:ffff:ffff:ffff')).toBe(bucket);
    expect(ipBucket('2001:db8:85a3:1:a:b:c:d%eth0')).toBe(bucket);
  });

  it('keeps neighbouring /64s apart', () => {
    expect(ipBucket('2001:db8:85a3:2::1')).not.toBe(ipBucket('2001:db8:85a3:1::1'));
  });

  it('expands :: in the routing half', () => {
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
  });

  it('reads an IPv4-mapped address as the IPv4 address', () => {
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('returns anything unparseable as it came', () => {
    for (const junk of ['unknown', '1:2:3', 'a::b::c', 'zz::1', '1:2:3:4:5:6:7:8:9']) {
      expect(ipBucket(junk)).toBe(junk);
    }
  });
});
