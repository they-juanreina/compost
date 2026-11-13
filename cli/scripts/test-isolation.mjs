// Hermetic test environment, loaded via `node --import` by the cli, web and
// plugin test scripts. Tests must never read the developer's real
// ~/.compost: a global `seeds.dir` there (or an exported $COMPOST_SEEDS_DIR)
// would redirect seed resolution, and `init`/`status` tests would then write
// into real seeds. CI has no ~/.compost, so this makes local runs match CI.
// Tests that need either variable set it explicitly.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The test runner spawns one child per file and children inherit the parent's
// env, so isolate once per run rather than once per file.
if (process.env.COMPOST_TEST_ISOLATED !== '1') {
  process.env.COMPOST_HOME = mkdtempSync(join(tmpdir(), 'compost-test-home-'))
  delete process.env.COMPOST_SEEDS_DIR
  process.env.COMPOST_TEST_ISOLATED = '1'
}
