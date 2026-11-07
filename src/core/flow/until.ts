// Until tests that can never hold (round 3: R2, AFD-103). The participant wrote
// `wait_policy_result == "installed"`: the registered result is a dict (rc, stdout, ...), so it
// never equals a string, and the step polls to the end every time.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `expr` compares the whole registered result `result` with a value: `r == "x"`,
 * `r != 0`, `"x" in r`, `r in [...]`. A field (`r.stdout`, `r['rc']`), a filter (`r | length`) or
 * a test (`r is succeeded`) is not.
 */
export function comparesWholeResult(expr: string, result: string): boolean {
  // A register name is an identifier (Register result as refuses anything else).
  if (!NAME.test(result)) return false;
  const bare = new RegExp(`(?<![A-Za-z0-9_.'"])${result}(?![A-Za-z0-9_'"])`, 'g');
  for (const m of expr.matchAll(bare)) {
    const before = expr.slice(0, m.index).trimEnd();
    const after = expr.slice((m.index ?? 0) + result.length).trimStart();
    if (/^[.[|]/.test(after) || /^is\b/.test(after)) continue;
    if (/(==|!=|\bin)$/.test(before) || /^(==|!=|in\b|not\s+in\b)/.test(after)) return true;
  }
  return false;
}
