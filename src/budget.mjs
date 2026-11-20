import { REQUEST_MS } from './config.mjs';

export const BUDGET_EXHAUSTED = Symbol('budget_exhausted');
export const REQUEST_TIMEOUT = Symbol('request_timeout');

export function createBudget(ms, now) {
  const started = now();
  const wallStarted = performance.now();
  const controller = new AbortController();
  const expire = () => controller.abort(BUDGET_EXHAUSTED);
  const timer = setTimeout(expire, ms);

  function remaining() {
    const left = Math.max(0, Math.ceil(ms - Math.max(now() - started, performance.now() - wallStarted)));
    if (!left) expire();
    return controller.signal.aborted ? 0 : left;
  }

  async function run(operation) {
    const left = remaining();
    if (!left) throw BUDGET_EXHAUSTED;
    const deadlineLimited = left <= REQUEST_MS;
    const request = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const requestTimer = deadlineLimited ? undefined : setTimeout(() => {
      if (remaining()) request.abort(REQUEST_TIMEOUT);
    }, REQUEST_MS);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([aborted, Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason;
        return operation(signal);
      })]);
      if (!remaining()) throw BUDGET_EXHAUSTED;
      return value;
    } catch (error) {
      if (!remaining()) throw BUDGET_EXHAUSTED;
      throw error;
    } finally {
      clearTimeout(requestTimer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return { started, run, remaining, close: () => clearTimeout(timer) };
}
