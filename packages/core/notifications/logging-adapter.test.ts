import { describe, expect, it, vi } from 'vitest';
import { LoggingChannelAdapter } from './logging-adapter';

const MESSAGE = {
  channel: 'email' as const,
  to: 'dana@example.com',
  template: 'appointment.confirmed',
  payload: { appointmentId: 'appt1', manageUrl: 'https://example.test/manage/SECRET-TOKEN-VALUE' },
};

describe('LoggingChannelAdapter', () => {
  it('supports every channel', () => {
    const adapter = new LoggingChannelAdapter();
    expect(adapter.supports('email')).toBe(true);
    expect(adapter.supports('sms')).toBe(true);
  });

  it('logs the message and returns a synthetic externalId', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = new LoggingChannelAdapter({ logPayloadValues: true });
    const result = await adapter.send(MESSAGE);
    expect(result.externalId).toMatch(/^log_/);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('email -> dana@example.com'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('appointment.confirmed'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('appt1'));
    spy.mockRestore();
  });

  // K10 (INV-13): the manage link is a bearer credential; by default only the
  // payload's KEYS reach the log, never its values.
  it('never logs payload values (the manage link) by default', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await new LoggingChannelAdapter().send(MESSAGE);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain('payloadKeys=appointmentId,manageUrl');
    expect(line).not.toContain('SECRET-TOKEN-VALUE');
    expect(line).not.toContain('/manage/');
    expect(line).not.toContain('appt1');
    spy.mockRestore();
  });

  it('copes with a payload that is not an object', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await new LoggingChannelAdapter().send({ ...MESSAGE, payload: null });
    expect(String(spy.mock.calls[0]?.[0])).toContain('payloadKeys=');
    spy.mockRestore();
  });
});
