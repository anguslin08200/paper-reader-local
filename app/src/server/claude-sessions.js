import { randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createClaudeSessionStore({ newId = randomUUID, now = Date.now, limit = 200, ttlMs = 24 * 60 * 60_000 } = {}) {
  const sessions = new Map();
  return {
    async run({ paperId, conversationId, model = 'sonnet' }, callback) {
      // A browser conversation token scopes resumable CLI history to one paper and model.
      if (conversationId !== undefined && !uuidPattern.test(conversationId)) throw new Error('對話 ID 無效，請開始新對話');
      const timestamp = now();
      for (const [key, session] of sessions) {
        if (!session.busy && timestamp - session.lastUsed > ttlMs) sessions.delete(key);
      }
      const key = JSON.stringify([paperId, conversationId ?? 'default', model]);
      let session = sessions.get(key);
      if (session?.busy) throw new Error('該 Claude 對話正在回答，請等待完成');
      if (!session) {
        // Bound browser-created sessions without ever evicting an active request.
        if (sessions.size >= limit) {
          const idle = [...sessions].filter(([, entry]) => !entry.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
          if (!idle.length) throw new Error('Claude 對話繁忙，請稍後重試');
          sessions.delete(idle[0][0]);
        }
        session = { id: newId(), ready: false, busy: false, lastUsed: timestamp };
        sessions.set(key, session);
      }
      session.busy = true;
      try {
        const result = await callback({ sessionId: session.id, resume: session.ready });
        session.ready = true;
        return result;
      } catch (error) {
        // A failed first invocation may have created partial CLI files: retry with a fresh UUID.
        if (!session.ready) sessions.delete(key);
        throw error;
      } finally {
        session.busy = false;
        session.lastUsed = now();
      }
    },
  };
}

export const claudeSessions = createClaudeSessionStore();
