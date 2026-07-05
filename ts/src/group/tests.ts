// Plan 10: shared test-file detection so test suites & integration tests are excluded
// from the grouping output. Segment/anchor matched (never substring) so `attestation.ts`,
// `latest.ts`, or a `contest/` folder are not mistaken for tests.

// Directory *segments* that mark a test/fixture tree (matched whole, not as substrings).
const TEST_DIR_SEGMENTS = new Set<string>([
  "__tests__", "tests", "test", "e2e", "integration", "spec",
  "__mocks__", "mocks", "fixtures", "testdata", "cypress", ".storybook",
]);

// Filename patterns (anchored) across common language conventions.
const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // foo.test.ts, foo.spec.tsx, foo.test.mjs
  /\.smoke\.[cm]?[jt]sx?$/i, // foo.smoke.ts
  /\.stories\.[cm]?[jt]sx?$/i, // storybook stories
  /_test\.go$/i, // Go: foo_test.go
  /(^|\/)test_[^/]*\.py$/i, // Python: test_foo.py
  /(^|\/)conftest\.py$/i, // pytest conftest
  /_spec\.rb$/i, // Ruby: foo_spec.rb
  /(^|\/)(jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s$/i, // test runner configs
];

/** True if `relPath` (forward-slash) is a test / integration-test / fixture file. */
export function isTestPath(relPath: string): boolean {
  const segments = relPath.split("/");
  for (const seg of segments.slice(0, -1)) if (TEST_DIR_SEGMENTS.has(seg)) return true;
  return TEST_FILE_PATTERNS.some((re) => re.test(relPath));
}
