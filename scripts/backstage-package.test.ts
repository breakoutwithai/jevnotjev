// `bun test` skips dot-directories, so `.deploy/backstage-package.test.ts` is never discovered
// by a plain `bun test` (issue #80). Importing it here registers its tests in the default run.
import "../.deploy/backstage-package.test.ts";
