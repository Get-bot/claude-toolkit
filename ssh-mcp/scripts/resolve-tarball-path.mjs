// Records the absolute path of the tarball `npm pack` just produced into SSH_MCP_TGZ for the
// steps that follow (GitHub Actions reads GITHUB_ENV between steps).
//
// Node rather than shell globbing so the logic is identical on both runners: git-bash and pwsh
// disagree about globs and about what `pwd` means on Windows, `fs.readdirSync` does not.
import { appendFileSync, readdirSync } from 'node:fs';
import { EOL } from 'node:os';
import { resolve } from 'node:path';

const tgz = readdirSync('.').find((f) => f.endsWith('.tgz'));
if (!tgz) {
  console.error('no .tgz produced by npm pack');
  process.exit(1);
}

const abs = resolve(tgz);
appendFileSync(process.env.GITHUB_ENV, `SSH_MCP_TGZ=${abs}${EOL}`);
console.log(`SSH_MCP_TGZ=${abs}`);
