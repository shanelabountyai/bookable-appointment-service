import { describe, expect, it, vi } from 'vitest';
import { LoggingChannelAdapter } from './logging-adapter';

describe('LoggingChannelAdapter', () => {
  it('supports every channel', () => {
    const adapter = new LoggingChannelAdapter();
    expect(adapter.supports('email')).toBe(true);
    expect(adapter.supports('sms')).toBe(true);
  });

  it('logs the message and returns a synthetic externalId', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = new LoggingChannelAdapter();
    const result = await adapter.send({
      channel: 'email',
      to: 'dana@example.com',
      template: 'appointment.confirmed',
      payload: { appointmentId: 'appt1' },
    });
    expect(result.externalId).toMatch(/^log_/);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('email -> dana@example.com'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('appointment.confirmed'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('appt1'));
    spy.mockRestore();
  });
});
