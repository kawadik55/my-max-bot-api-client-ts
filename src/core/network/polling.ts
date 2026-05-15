import createDebug from 'debug';

import type { Api } from '../../api';
import { MaxError, Update, UpdateType } from './api';

const debug = createDebug('one-me:polling');

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 10_000];

export function isRetryableError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  if (err.name === 'FetchError') return true;
  if (err.name === 'TimeoutError') return true;
  if (err instanceof TypeError && err.message === 'fetch failed') return true; // нативный fetch, сбой соединения
  if (err instanceof MaxError && err.status === 429) return true;
  if (err instanceof MaxError && err.status >= 500) return true;
  return false;
}

function getRetryDelay(retryCount: number): number {
  return RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
}

export class Polling {
  private readonly abortController = new AbortController();

  private marker?: number;

  constructor(
    private readonly api: Api,
    private readonly allowedUpdates: UpdateType[] = [],
  ) {}

  loop = async (
    handleUpdate: (update: Update) => Promise<void>,
    onPollingError?: (err: Error, retryCount: number, nextDelayMs: number) => void,
  ): Promise<void> => {
    debug('Starting long polling');
    let retryCount = 0;
    while (!this.abortController.signal.aborted) {
      try {
        const { updates, marker } = await this.api.getUpdates(this.allowedUpdates, {
          marker: this.marker,
        });
        this.marker = marker;
        retryCount = 0;
        await Promise.all(updates.map(handleUpdate));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (isRetryableError(err)) {
          const delay = getRetryDelay(retryCount);
          retryCount += 1;
          debug(`Failed to fetch updates (attempt ${retryCount}), retrying after ${delay}ms.`, err);
          onPollingError?.(err, retryCount, delay);
          await new Promise((resolve) => { setTimeout(resolve, delay); });
        } else {
          throw err;
        }
      }
    }
    debug('Long polling is done');
  };

  stop = () => {
    debug('Stopping long polling');
    this.abortController.abort();
  };
}
