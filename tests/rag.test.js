import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSectionsFromMarkdown,
  normalizeMineruMarkdown,
  rankSectionsBm25,
  cosineSimilarity,
  normalizeVector,
  splitSectionsForEmbedding,
} from '../src/server/rag.js';

test('builds hierarchical Markdown sections and ignores H1', () => {
  const result = buildSectionsFromMarkdown(`
# Paper title
Authors
## 3 Methods
Method overview.
### 3.1 Framework
Framework details.
### 3.2 Training
Training details.
## 4 Results
Results overview.
`);

  assert.deepEqual(result.map(({ title, level }) => ({ title, level })), [
    { title: '3 Methods', level: 2 },
    { title: '3 Methods / 3.1 Framework', level: 3 },
    { title: '3 Methods / 3.2 Training', level: 3 },
    { title: '4 Results', level: 2 },
  ]);
  assert.match(result[0].text, /^## 3 Methods\n\nMethod overview/);
  assert.match(result[1].text, /^## 3 Methods\n### 3.1 Framework/);
  assert.doesNotMatch(result[0].text, /Paper title|Authors/);
});

test('converts Expert HTML tables to Markdown before embedding', () => {
  const result = buildSectionsFromMarkdown(`## 3 Method

Text before.

<table><tr><td></td><td>\\( M{I}_{0,0} \\)</td></tr><tr><td>DTC</td><td>1.00</td></tr></table>

Text after.`);

  assert.equal(result.length, 1);
  assert.match(result[0].text, /M\{I\}_\{0,0\}/);
  assert.match(result[0].text, /\| --- \| --- \|/);
  assert.match(result[0].text, /\| DTC \| 1\.00 \|/);
  assert.match(result[0].text, /Text after\./);
  assert.doesNotMatch(result[0].text, /<table|<td/);
});

test('splits long chapters while preserving the H2/H3 context', () => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} ${'retrieval context '.repeat(20)}`).join('\n\n');
  const sections = buildSectionsFromMarkdown(`## 3 Methods\n### 3.2 Framework\n${paragraphs}`);
  const chunks = splitSectionsForEmbedding(sections);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 4000));
  assert.ok(chunks.every((chunk) => chunk.title === '3 Methods / 3.2 Framework'));
  assert.ok(chunks.every((chunk) => /^## 3 Methods\n### 3.2 Framework/.test(chunk.text)));
});

test('normalizes vectors and computes cosine similarity', () => {
  const left = normalizeVector([3, 4]);
  const right = normalizeVector([4, 3]);
  assert.equal(left[0], 0.6);
  assert.equal(left[1], 0.8);
  assert.equal(cosineSimilarity(left, right), 0.96);
});


test('retains MinerU abstract, chapter, subsection, equations and images', () => {
  const markdown = `Title and authors
# Abstract
\u6458\u8981 $E=mc^2$
# 3 Methods
\u65b9\u6cd5
## 3.2 Framework
\u6846\u67b6 ![\u5716](images/example.png)
# 4 Results
\u7d50\u679c`;
  const sections = buildSectionsFromMarkdown(normalizeMineruMarkdown(markdown));
  const combined = sections.map((section) => section.text).join('\n');
  for (const text of ['Title and authors', '\u6458\u8981', '$E=mc^2$', '\u65b9\u6cd5', '\u6846\u67b6', 'images/example.png', '\u7d50\u679c']) assert.ok(combined.includes(text), text);
  assert.ok(sections.some((section) => section.title === '3 Methods / 3.2 Framework'));
});

test('BM25 ranks matching Chinese and English sections without an API key', () => {
  const sections = [
    { title: 'Results', text: '\u5be6\u9a57\u7d50\u679c\u8207\u8aa4\u5dee\u5206\u6790' },
    { title: 'Methods', text: '\u795e\u7d93\u7db2\u8def\u6a21\u578b attention' },
    { title: 'Other', text: 'The experiments used a baseline model.' },
  ];
  assert.equal(rankSectionsBm25(sections, '\u795e\u7d93\u7db2\u8def attention')[0].title, 'Methods');
  assert.equal(rankSectionsBm25(sections, '\u8aa4\u5dee\u5206\u6790')[0].title, 'Results');
});
