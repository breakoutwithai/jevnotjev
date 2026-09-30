// Preloaded by bunfig.toml: drop the run's throwaway database once, after the last test file.

import { afterAll } from "bun:test";
import { dropDatabase } from "./support.ts";

afterAll(dropDatabase);
