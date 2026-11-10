// Settings of the feedback page. Each value is one string literal, so a deploy step can replace
// it (for example with sed) without a build.

/** The Cloudflare Worker that files each answer (feedback/worker). */
export const WORKER_URL = 'https://afd-feedback.sergei-chistokhin.workers.dev/feedback';

/**
 * Turnstile site key (public), for the hostname chistokhinsv.github.io. For a local test use
 * Cloudflare's always-pass test key 1x00000000000000000000AA with its test secret on the Worker.
 */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAF7oWJM7fNzM50eF';

export const RATE_URL_VSCODE =
  'https://marketplace.visualstudio.com/items?itemName=chistokhinsv.ansible-flow-designer&ssr=false#review-details';

export const RATE_URL_OPENVSX = 'https://open-vsx.org/extension/chistokhinsv/ansible-flow-designer';

export const ISSUES_URL = 'https://github.com/ChistokhinSV/ansible-flow-designer/issues/new/choose';
