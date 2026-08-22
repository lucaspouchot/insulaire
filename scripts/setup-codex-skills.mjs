import { lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const sourceDirectory = path.join(repositoryRoot, '.claude', 'skills');
const targetDirectory = path.join(repositoryRoot, '.agents', 'skills');

async function exists(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

await mkdir(targetDirectory, { recursive: true });

const entries = await readdir(sourceDirectory, { withFileTypes: true });
for (const entry of entries.filter((entry) => entry.isDirectory())) {
  const target = path.join(targetDirectory, entry.name);
  const expectedLink = path.join('..', '..', '.claude', 'skills', entry.name);
  const targetStats = await exists(target);

  if (!targetStats) {
    await symlink(expectedLink, target, 'dir');
    console.log(`linked .agents/skills/${entry.name}`);
    continue;
  }

  if (!targetStats.isSymbolicLink() || (await readlink(target)) !== expectedLink) {
    throw new Error(
      `${path.relative(repositoryRoot, target)} already exists and is not the expected link; refusing to overwrite it.`,
    );
  }
}
