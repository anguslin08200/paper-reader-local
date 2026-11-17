import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Per-paper conversation persisted next to the paper, so history and AI memory survive reloads/restarts.
// Shape: { conversationId, claude: { sessionId, ready, model }, turns: [{ question, answer, task, label, at }] }

const MAX_TURNS = 200;
// Codex/Pi have no resumable session here: replay recent turns within a bounded prompt budget.
const HISTORY_TURNS = 8;
const HISTORY_ANSWER_CHARS = 1800;
const HISTORY_TOTAL_CHARS = 14000;

const chatPath = (directory) => path.join(directory, 'chat.json');
const locks = new Map();

function emptyChat() {
  return { conversationId: randomUUID(), claude: null, turns: [] };
}

export async function readChat(directory) {
  try {
    const chat = JSON.parse(await readFile(chatPath(directory), 'utf8'));
    return { ...emptyChat(), ...chat, turns: Array.isArray(chat.turns) ? chat.turns : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyChat();
    throw error;
  }
}

async function writeChat(directory, chat) {
  // Atomic replace so a crash never leaves a truncated history file.
  const temporary = `${chatPath(directory)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(chat, null, 2));
  await rename(temporary, chatPath(directory));
}

// Serialize read-modify-write per paper directory.
export async function updateChat(directory, mutate) {
  const previous = locks.get(directory) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(directory, previous.then(() => current));
  await previous;
  try {
    const chat = await readChat(directory);
    const result = await mutate(chat);
    chat.turns = chat.turns.slice(-MAX_TURNS);
    await writeChat(directory, chat);
    return result ?? chat;
  } finally {
    release();
    if (locks.get(directory) === current) locks.delete(directory);
  }
}

export async function resetChat(directory) {
  await rm(chatPath(directory), { force: true });
  return readChat(directory);
}

export function appendTurn(chat, turn) {
  chat.turns.push({ ...turn, at: new Date().toISOString() });
}

// Compact transcript of the most recent turns for providers without native session memory.
export function historyContext(turns) {
  const recent = turns.slice(-HISTORY_TURNS);
  const blocks = [];
  let total = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    const answer = turn.answer.length > HISTORY_ANSWER_CHARS ? `${turn.answer.slice(0, HISTORY_ANSWER_CHARS)}…（後略）` : turn.answer;
    const block = `【第 ${turns.length - recent.length + index + 1} 輪】${turn.label ? `（附件：${turn.label}）` : ''}\n使用者：${turn.question}\n助手：${answer}`;
    if (total + block.length > HISTORY_TOTAL_CHARS && blocks.length) break;
    blocks.unshift(block);
    total += block.length;
  }
  return blocks.join('\n\n');
}
