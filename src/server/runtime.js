import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve defaults from the repository, so shortcuts and isolated checks never depend on cwd.
export const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeDirectory = path.resolve(process.env.PAPER_READER_RUNTIME_DIR || path.join(projectDirectory, '.runtime'));
