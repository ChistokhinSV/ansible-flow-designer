// Worker entry: binds the runtime (fetch, the rate limiter) and hands over to the handler.

import { type Env, handle } from './handler';

interface WorkerEnv extends Env {
  /** The [[ratelimits]] binding in wrangler.toml; without it the Worker runs unlimited. */
  RATE_LIMITER?: RateLimit;
}

export default {
  fetch(request, env) {
    return handle(request, env, {
      // Wrapped: the global fetch called as a method of another object throws
      // "Illegal invocation" in workerd.
      fetch: (url, init) => fetch(url, init),
      limiter: env.RATE_LIMITER,
    });
  },
} satisfies ExportedHandler<WorkerEnv>;
