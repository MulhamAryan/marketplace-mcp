import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Loaded before every test file: logs, spool and databases of in-process tests go to a throwaway
// directory, never to the developer's real ~/.eonix-mem.
if (!process.env.EONIX_MEM_DATA_DIR) {
  process.env.EONIX_MEM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eonix-mem-unit-'));
}
