import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bot } from '../src/bot';

const mockLoop = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock('../src/core/network/polling', () => ({
  Polling: vi.fn().mockImplementation(function () {
    return { loop: mockLoop, stop: mockStop };
  }),
}));

vi.mock('../src/api', () => ({
  Api: vi.fn().mockImplementation(function () {
    return { getMyInfo: vi.fn().mockResolvedValue({ username: 'testbot', user_id: 1 }) };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Bot', () => {
  describe('isPollingActive()', () => {
    it('returns false before start()', () => {
      const bot = new Bot('test-token');
      expect(bot.isPollingActive()).toBe(false);
    });

    it('returns true immediately after start() is called (synchronous)', () => {
      const bot = new Bot('test-token');
      bot.start();
      expect(bot.isPollingActive()).toBe(true);
    });

    it('returns false after stop()', () => {
      const bot = new Bot('test-token');
      bot.start();
      bot.stop();
      expect(bot.isPollingActive()).toBe(false);
    });
  });

  describe('start() options', () => {
    it('passes onPollingError to polling.loop()', async () => {
      const onPollingError = vi.fn();
      const bot = new Bot('test-token');
      await bot.start({ onPollingError });
      expect(mockLoop).toHaveBeenCalledWith(
        expect.any(Function),
        onPollingError,
      );
    });

    it('passes undefined to polling.loop() when onPollingError not provided', async () => {
      const bot = new Bot('test-token');
      await bot.start();
      expect(mockLoop).toHaveBeenCalledWith(
        expect.any(Function),
        undefined,
      );
    });

    it('does not start polling twice if already running', async () => {
      const bot = new Bot('test-token');
      await bot.start();
      await bot.start();
      expect(mockLoop).toHaveBeenCalledTimes(1);
    });
  });
});
