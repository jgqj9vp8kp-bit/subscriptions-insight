// Shared build identifier (plan §26.6). Every Edge response carries it as the
// `x-build-id` header so the one-shot deploy of all functions can be gated on
// "every function reports the same id" — a function left on an older build
// (still binding the caller as tenant) is then visible before employees exist.
// Bump it whenever the access layer changes in a way that must deploy together.

export const BUILD_ID = "access-p1-2026-10-05";
