// The demo gate decides whether a request gets challenged. Pure — no request
// object, no env.
import { describe, expect, it } from 'vitest';
import { demoChallenge } from './demo-gate';

const PASSWORD = 'shear-genius-demo';
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe('demoChallenge', () => {
  it('lets everything through when no password is set', () => {
    expect(demoChallenge('/book', null, undefined)).toBeNull();
    expect(demoChallenge('/staff/day', null, '')).toBeNull();
  });

  it('challenges an unauthenticated request once a password is set', () => {
    const challenge = demoChallenge('/book', null, PASSWORD);
    expect(challenge?.status).toBe(401);
    expect(challenge?.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('never indexes or caches a challenge', () => {
    const challenge = demoChallenge('/book', null, PASSWORD);
    expect(challenge?.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(challenge?.headers['Cache-Control']).toBe('no-store');
  });

  it('accepts the right password, whatever the username', () => {
    expect(demoChallenge('/book', basic('demo', PASSWORD), PASSWORD)).toBeNull();
    expect(demoChallenge('/book', basic('', PASSWORD), PASSWORD)).toBeNull();
  });

  it('gates the staff sign-in page too', () => {
    expect(demoChallenge('/staff/login', null, PASSWORD)?.status).toBe(401);
  });

  // The one route with its own authentication (a CRON_SECRET bearer). Gating
  // it would stop Vercel Cron.
  it('leaves the reminder job to its own auth', () => {
    expect(demoChallenge('/api/jobs/reminders', null, PASSWORD)).toBeNull();
  });

  // An exemption is an exact path, never a prefix: a sibling route under
  // /api/jobs must not inherit it.
  it('does not exempt a path that merely starts with the exempt one', () => {
    expect(demoChallenge('/api/jobs/reminders-export', null, PASSWORD)?.status).toBe(401);
    expect(demoChallenge('/api/jobs', null, PASSWORD)?.status).toBe(401);
  });

  it.each([
    ['the wrong password', basic('demo', 'wrong')],
    ['a password that is a prefix', basic('demo', PASSWORD.slice(0, -1))],
    ['a password with trailing space', basic('demo', `${PASSWORD} `)],
    ['no colon in the decoded pair', `Basic ${btoa(PASSWORD)}`],
    ['undecodable base64', 'Basic !!!not-base64!!!'],
    ['a bearer token carrying the password', `Bearer ${PASSWORD}`],
    ['an empty header', ''],
  ])('challenges %s', (_label, authorization) => {
    expect(demoChallenge('/book', authorization, PASSWORD)?.status).toBe(401);
  });

  it('accepts a password containing a colon', () => {
    const withColon = 'a:b:c';
    expect(demoChallenge('/book', basic('demo', withColon), withColon)).toBeNull();
  });
});
