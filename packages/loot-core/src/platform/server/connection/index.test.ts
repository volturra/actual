// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// oxlint-disable-next-line no-restricted-imports
import { init } from './index';

type Listener = (event: { data: unknown }) => void;

function createChannel() {
  const listeners: Listener[] = [];
  const posted: unknown[] = [];
  const channel = {
    addEventListener: (_type: string, listener: Listener) => {
      listeners.push(listener);
    },
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
  };
  const receive = (data: unknown) => {
    listeners.forEach(listener => listener({ data }));
  };
  return { channel, posted, receive };
}

function connectCount(posted: unknown[]) {
  return posted.filter(msg => (msg as { type?: string }).type === 'connect')
    .length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('posts the first connect synchronously from init', () => {
  const { channel, posted, receive } = createChannel();
  // Only the parts of a worker's global scope the connection uses
  init(channel as unknown as Window, {} as Parameters<typeof init>[1]);

  expect(connectCount(posted)).toBe(1);

  // The interval keeps retrying until the client says it is connected.
  vi.advanceTimersByTime(200);
  expect(connectCount(posted)).toBe(2);

  receive({ name: 'client-connected-to-backend' });
  vi.advanceTimersByTime(1000);
  expect(connectCount(posted)).toBe(2);
});
