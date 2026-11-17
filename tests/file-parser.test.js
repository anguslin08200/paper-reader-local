import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { parsePdf, parsePdfWithExpert } from '../src/server/file-parser.js';

const settings = {
  rag: { parserBaseUrl: 'https://expert.test/v4', parserApiKey: 'test-key' },
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function zipResponse(files) {
  const zip = zipSync(Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]),
  ));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-expert-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mockFetch(implementation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return implementation(url, init, calls);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test('uploads, polls, downloads without forwarding auth, and persists Expert output', async () => {
  await withDirectory(async (directory) => {
    const zip = zipResponse({ 'result.md': '# Parsed', 'images/figure.jpg': new Uint8Array([1, 2, 3]) });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) {
        assert.equal(url, 'https://expert.test/v4/files/parser/create');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer test-key');
        assert.ok(init.body instanceof FormData);
        return jsonResponse({ task_id: 'task-1', request_id: 'req-1' });
      }
      if (calls.length === 2) return jsonResponse({ status: 'processing', parsing_result_url: 'https://signed.test/ignored' });
      if (calls.length === 3) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      assert.equal(url, 'https://signed.test/result');
      assert.equal(init.headers, undefined);
      return zip;
    });
    try {
      const result = await parsePdfWithExpert(Buffer.from('%PDF'), directory, settings, undefined, {
        pollIntervalMs: 0,
        timeoutMs: 1000,
      });
      assert.deepEqual(result, {
        markdown: '# Parsed',
        taskId: 'task-1',
        images: [{ path: 'parsed/images/figure.jpg' }],
      });
      assert.equal(await readFile(path.join(directory, 'parsed/result.md'), 'utf8'), '# Parsed');
      assert.deepEqual(await readFile(path.join(directory, 'parsed/images/figure.jpg')), Buffer.from([1, 2, 3]));
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'parse-task.json'), 'utf8')), {
        task_id: 'task-1',
        create: { task_id: 'task-1', request_id: 'req-1' },
        result: { status: 'succeeded' },
        status: 'succeeded',
      });
    } finally {
      fetchMock.restore();
    }
  });
});

test('reports Expert HTTP failures and invalid task responses', async () => {
  await withDirectory(async (directory) => {
    const fetchMock = mockFetch(() => jsonResponse({ error: { message: 'bad request' } }, 400));
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings),
        /智譜 Expert.*HTTP 400.*bad request/,
      );
    } finally {
      fetchMock.restore();
    }
  });

  await withDirectory(async (directory) => {
    const fetchMock = mockFetch(() => jsonResponse({ request_id: 'without-task-id' }));
    try {
      await assert.rejects(parsePdfWithExpert(Buffer.from('pdf'), directory, settings), /缺少 task_id/);
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects a failed Expert task status', async () => {
  await withDirectory(async (directory) => {
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-failed' });
      return jsonResponse({ status: 'failed', error: { message: 'parse failed' } });
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /智譜 Expert.*解析任務失敗.*failed/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects unsafe ZIP paths', async () => {
  await withDirectory(async (directory) => {
    const archive = zipResponse({ 'result.md': 'ok', '../outside.jpg': 'bad' });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-traversal' });
      if (calls.length === 2) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      return archive;
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /ZIP 包包含不安全路徑/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects missing or empty result.md', async () => {
  await withDirectory(async (directory) => {
    const archive = zipResponse({ 'images/figure.jpg': 'image' });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-no-md' });
      if (calls.length === 2) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      return archive;
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /缺少非空 result.md/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('fails before upload when the parser key is missing', async () => {
  await withDirectory(async (directory) => {
    const originalKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    const fetchMock = mockFetch(() => { throw new Error('must not call fetch'); });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, { rag: { parserBaseUrl: 'https://expert.test' } }),
        /未配置 parser API key/,
      );
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      if (originalKey === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = originalKey;
      fetchMock.restore();
    }
  });
});


test('reuses a validated MinerU cache and records the PDF hash', async () => {
  await withDirectory(async (directory) => {
    const pdf = Buffer.from('%PDF cache test');
    const sha = createHash('sha256').update(pdf).digest('hex');
    const cache = path.join(directory, 'cache');
    const root = path.join(cache, sha);
    await mkdir(path.join(root, 'images'), { recursive: true });
    await writeFile(path.join(root, 'cache.json'), JSON.stringify({ sha, files: ['figure.png'] }));
    await writeFile(path.join(root, 'markdown.md'), '# Abstract\n\u5167\u5bb9 $E=mc^2$\n![\u5716](images/figure.png)');
    await writeFile(path.join(root, 'images/figure.png'), 'figure');
    const paper = path.join(directory, 'paper');
    const result = await parsePdf(pdf, paper, { rag: { mineruCacheDirectory: cache, mineruExecutable: 'must-not-run' } });
    assert.equal(result.sha256, sha);
    assert.match(result.markdown, /\u5167\u5bb9/);
    assert.deepEqual(result.images, [{ path: 'parsed/images/figure.png' }]);
    assert.deepEqual(await readFile(path.join(paper, 'original.pdf')), pdf);
    assert.equal(JSON.parse(await readFile(path.join(paper, 'parse-task.json'), 'utf8')).sha256, sha);
    assert.equal(await readFile(path.join(paper, 'parsed/images/figure.png'), 'utf8'), 'figure');
  });
});

test('does not trust a cache manifest for a different hash', async () => {
  await withDirectory(async (directory) => {
    const pdf = Buffer.from('other pdf');
    const sha = createHash('sha256').update(pdf).digest('hex');
    const root = path.join(directory, 'cache', sha);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'cache.json'), JSON.stringify({ sha: 'wrong', files: [] }));
    await writeFile(path.join(root, 'markdown.md'), '# invalid cache');
    await assert.rejects(parsePdf(pdf, path.join(directory, 'paper'), { rag: {
      mineruCacheDirectory: path.join(directory, 'cache'), mineruExecutable: path.join(directory, 'missing-executable'),
    } }));
  });
});


test('runs MinerU with its environment and extracts the result archive', async () => {
  await withDirectory(async (directory) => {
    const paper = path.join(directory, 'paper');
    const calls = [];
    const runFile = async (executable, args, options) => {
      calls.push({ executable, args, options });
      await writeFile(args[3], zipSync({
        'markdown.md': strToU8('# Abstract\nText with $x^2$'),
        'middle_json.json': strToU8('{"pages":[]}'),
        'images/figure.png': strToU8('figure'),
      }));
    };
    const result = await parsePdf(Buffer.from('pdf'), paper, { rag: {
      mineruCacheDirectory: path.join(directory, 'empty-cache'), mineruExecutable: 'mineru-test', mineruHome: 'mineru-home',
    } }, undefined, { runFile });
    assert.equal(calls[0].executable, 'mineru-test');
    // Output goes to a short system-temp folder (Windows path-length safety), then is copied back.
    assert.deepEqual([...calls[0].args.slice(0, 3), ...calls[0].args.slice(4)], ['parse', path.join(paper, 'original.pdf'), '-o', '-f', 'zip', '--tier', 'standard']);
    assert.ok(calls[0].args[3].startsWith(path.join(tmpdir(), 'pr-mineru-')) && calls[0].args[3].endsWith('result.zip'));
    assert.equal(calls[0].options.env.MINERU_HOME, 'mineru-home');
    assert.equal(calls[0].options.env.PYTHONIOENCODING, 'utf-8');
    assert.match(result.markdown, /x\^2/);
    assert.equal(await readFile(path.join(paper, 'parsed/middle_json.json'), 'utf8'), '{"pages":[]}');
    assert.equal(await readFile(path.join(paper, 'parsed/images/figure.png'), 'utf8'), 'figure');
  });
});

// Verify the parser consumes environment paths, even when different paths were saved.
test('MinerU environment overrides are passed to the local process', async () => {
  const keys = ['MINERU_KIT', 'MINERU_HOME', 'MINERU_CACHE_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await withDirectory(async (directory) => {
      process.env.MINERU_KIT = 'environment-kit';
      process.env.MINERU_HOME = 'environment-home';
      process.env.MINERU_CACHE_DIR = path.join(directory, 'environment-cache');
      let call;
      await parsePdf(Buffer.from('test pdf'), path.join(directory, 'paper'), { rag: {
        mineruExecutable: 'saved-kit', mineruHome: 'saved-home', mineruCacheDirectory: path.join(directory, 'saved-cache'),
      } }, undefined, { runFile: async (executable, args, options) => {
        call = { executable, options };
        await writeFile(args[3], zipSync({ 'markdown.md': strToU8('# Parsed') }));
      } });
      assert.equal(call.executable, 'environment-kit');
      assert.equal(call.options.env.MINERU_HOME, 'environment-home');
    });
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
