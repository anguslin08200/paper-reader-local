import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { retrievePaperSections } from './rag.js';

const paperSearchTool = defineTool({
  name: 'paper_search',
  label: 'Paper Search',
  // BM25 is lexical, so ask the agent to search with the paper's own terminology.
  description: '檢索目前論文的本機章節索引。全文概括、跨章節比較或目前頁資訊不足時使用。預設 BM25，請使用論文原文的關鍵詞（英文論文優先用英文）；無命中時換用同義關鍵詞，不把低分結果當作證據。',
  parameters: Type.Object({
    query: Type.String({ description: '用於檢索論文全文的自然語言問題' }),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '返回的小節數量，省略時使用應用配置' })),
  }),

  async execute(_toolCallId, params, signal) {
    const paperId = process.env.PAPER_READER_RAG_PAPER_ID;
    if (!paperId) throw new Error('全文檢索工具缺少目前論文 ID');
    const results = await retrievePaperSections(paperId, params.query, params.topK, signal);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map((result) => ({
            section: result.title,
            pages: result.pageStart == null
              ? '未知'
              : result.pageStart === result.pageEnd
                ? `${result.pageStart}`
                : `${result.pageStart}-${result.pageEnd}`,
            score: Number(result.score.toFixed(4)),
            content: result.text,
          })),
        }, null, 2),
      }],
      details: { results },
    };
  },
});

export default function registerPaperSearchTool(pi) {
  pi.registerTool(paperSearchTool);
}
