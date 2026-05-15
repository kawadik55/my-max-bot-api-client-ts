import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRetryableError, Polling } from '../src/core/network/polling';
import { MaxError } from '../src/core/network/api';
import type { Api } from '../src/api';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeMockApi(impl: () => Promise<{ updates: never[]; marker: number }>) {
  return { getUpdates: vi.fn(impl) } as unknown as Api;
}

describe('isRetryableError', () => {
  it('returns false for non-Error values', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });

  it('returns false for AbortError', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns true for FetchError (legacy node-fetch)', () => {
    const err = Object.assign(new Error('network error'), { name: 'FetchError' });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for TimeoutError (Node.js 22+ DOMException)', () => {
    const err = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for TypeError (native fetch connection failure)', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('returns true for MaxError 429', () => {
    const err = new MaxError(429, { code: 'rate_limited', message: 'Too many requests' });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for MaxError 500', () => {
    const err = new MaxError(500, { code: 'server_error', message: 'Internal server error' });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for MaxError 503', () => {
    const err = new MaxError(503, { code: 'unavailable', message: 'Service unavailable' });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for MaxError 400', () => {
    const err = new MaxError(400, { code: 'bad_request', message: 'Bad request' });
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isRetryableError(new Error('Unknown'))).toBe(false);
  });
});

describe('Polling.loop', () => {
  it('retries after a retryable error instead of stopping', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const polling = new Polling(makeMockApi(async () => {
      callCount += 1;
      if (callCount === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    const promise = polling.loop(vi.fn());
    await vi.runAllTimersAsync();
    await promise;

    expect(callCount).toBe(2);
  });

  it('exits cleanly when stop() is called', async () => {
    const polling = new Polling(makeMockApi(async () => {
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    await expect(polling.loop(vi.fn())).resolves.toBeUndefined();
  });

  it('throws on non-retryable errors', async () => {
    const polling = new Polling(makeMockApi(async () => {
      throw new Error('Unexpected fatal error');
    }), []);

    await expect(polling.loop(vi.fn())).rejects.toThrow('Unexpected fatal error');
  });

  it('applies exponential backoff: 1s→2s→4s→8s→10s→10s', async () => {
    vi.useFakeTimers();
    const onPollingError = vi.fn();
    let callCount = 0;
    const polling = new Polling(makeMockApi(async () => {
      callCount += 1;
      if (callCount <= 6) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    const promise = polling.loop(vi.fn(), onPollingError);
    await vi.runAllTimersAsync();
    await promise;

    const delays = onPollingError.mock.calls.map(([, , delay]: [Error, number, number]) => delay);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });

  it('resets retry count to 0 after a successful request', async () => {
    vi.useFakeTimers();
    const onPollingError = vi.fn();
    let callCount = 0;
    const polling = new Polling(makeMockApi(async () => {
      callCount += 1;
      if (callCount === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (callCount === 2) return { updates: [], marker: 0 };
      if (callCount === 3) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    const promise = polling.loop(vi.fn(), onPollingError);
    await vi.runAllTimersAsync();
    await promise;

    const delays = onPollingError.mock.calls.map(([, , delay]: [Error, number, number]) => delay);
    expect(delays).toEqual([1000, 1000]);
  });

  it('calls onPollingError with correct (err, retryCount, nextDelayMs)', async () => {
    vi.useFakeTimers();
    const onPollingError = vi.fn();
    const timeoutErr = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    let callCount = 0;
    const polling = new Polling(makeMockApi(async () => {
      callCount += 1;
      if (callCount === 1) throw timeoutErr;
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    const promise = polling.loop(vi.fn(), onPollingError);
    await vi.runAllTimersAsync();
    await promise;

    expect(onPollingError).toHaveBeenCalledOnce();
    expect(onPollingError).toHaveBeenCalledWith(timeoutErr, 1, 1000);
  });

  it('silently retries when onPollingError is not provided', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const polling = new Polling(makeMockApi(async () => {
      callCount += 1;
      if (callCount === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      polling.stop();
      return { updates: [], marker: 0 };
    }), []);

    const promise = polling.loop(vi.fn()); // onPollingError not provided
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined(); // loop resolves without error
    expect(callCount).toBe(2);
  });
});
