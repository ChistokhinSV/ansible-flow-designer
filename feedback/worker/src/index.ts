// Worker entry: binds the runtime (fetch, the rate limiter, the event store) and hands over to the
// handler.

import { type Deps, dailySummary, type Env, handle } from './handler';

interface WorkerEnv extends Env {
  /** The [[ratelimits]] binding in wrangler.toml; without it the Worker runs unlimited. */
  RATE_LIMITER?: RateLimit;
  /** AFD-215: the [[kv_namespaces]] binding of page opens and answers; without it none are kept. */
  VISITS?: KVNamespace;
}

function deps(env: WorkerEnv): Deps {
  return {
    // Wrapped: the global fetch called as a method of another object throws
    // "Illegal invocation" in workerd.
    fetch: (url, init) => fetch(url, init),
    limiter: env.RATE_LIMITER,
    store: env.VISITS,
  };
}

export default {
  fetch(request, env) {
    return handle(request, env, deps(env));
  },
  // AFD-215: the [triggers] cron in wrangler.toml, once a day: yesterday's opens and answers.
  scheduled(controller, env, ctx) {
    ctx.waitUntil(dailySummary(env, deps(env), new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<WorkerEnv>;
