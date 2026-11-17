import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MinerU locations, in priority order: environment variables, saved settings, a copy installed
// inside the project by setup.ps1 (tools/mineru), then a sibling ../mineru folder.
const bundled = {
  executable: fileURLToPath(new URL('../../tools/mineru/.venv/Scripts/mineru-kit.exe', import.meta.url)),
  home: fileURLToPath(new URL('../../tools/mineru/home', import.meta.url)),
};
const sibling = {
  executable: fileURLToPath(new URL('../../../mineru/.venv/Scripts/mineru-kit.exe', import.meta.url)),
  home: fileURLToPath(new URL('../../../mineru/home', import.meta.url)),
};

export function mineruConfig(rag = {}) {
  const fallback = existsSync(bundled.executable) ? bundled : sibling;
  return {
    executable: process.env.MINERU_KIT || rag.mineruExecutable || fallback.executable,
    home: process.env.MINERU_HOME || rag.mineruHome || fallback.home,
    cacheDirectory: process.env.MINERU_CACHE_DIR || rag.mineruCacheDirectory || '',
  };
}
