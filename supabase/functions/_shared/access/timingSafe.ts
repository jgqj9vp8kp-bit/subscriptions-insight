// Constant-time string comparison for shared secrets (cron secret, internal
// mail secret). `a === b` returns at the first differing character, which leaks
// the length of the matching prefix through response timing (plan §12.7).
//
// The loop always walks the LONGER of the two strings and folds every code unit
// difference plus the length difference into one accumulator, so the time taken
// depends only on max(len(a), len(b)) — never on where the strings differ.
// charCodeAt past the end returns NaN and `NaN | 0` is 0, so there is no
// per-index branch on the input lengths either.

export function timingSafeEqual(a: string, b: string): boolean {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}
