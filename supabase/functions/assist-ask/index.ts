// assist-ask: answers a plain-language question about the weekly numbers with
// Claude (docs/ai-assist.md AI-5). Runs on Supabase Edge Functions (Deno).
//
// - The Anthropic key is the Supabase secret ANTHROPIC_API_KEY. It never goes to
//   the browser or the repository.
// - Every database call uses the caller's own sign-in, so row-level security and
//   the role checks in app_assist_start apply (ask_assist, 20 a day).
// - The answer is shown only when every line cites records it was given.

import Anthropic from 'npm:@anthropic-ai/sdk@0.136.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { ANSWER_SCHEMA, MODEL, SYSTEM, allowedRecords, badRequest, checkLines, parseAnswer, userTurn, type AskRequest } from './logic.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return reply(401, { error: 'Sign in first.' });
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return reply(503, { error: 'Questions are not set up yet: the ANTHROPIC_API_KEY secret is missing.' });

  const raw = await req.text();
  let body: AskRequest;
  try { body = JSON.parse(raw); } catch { return reply(400, { error: 'Send a JSON body.' }); }
  const bad = badRequest(body, new TextEncoder().encode(raw).length);
  if (bad) return reply(400, { error: bad });

  // The caller's sign-in, not a service key: the database decides who may ask.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const start = await db.rpc('app_assist_start', { p_site: body.siteId, p_question: body.question.trim() });
  if (start.error) {
    const msg = start.error.message ?? '';
    const code = /limit/i.test(msg) ? 429 : /permission|not allowed|insufficient/i.test(msg) || start.error.code === '42501' ? 403 : 400;
    return reply(code, { error: msg || 'Could not start the question.' });
  }
  const questionId = start.data as string;
  const finish = (outcome: string, extra: { lines?: string[]; cited?: string[]; inTok?: number; outTok?: number; model?: string } = {}) =>
    db.rpc('app_assist_finish', {
      p_id: questionId, p_outcome: outcome, p_lines: extra.lines ?? [], p_cited: extra.cited ?? [],
      p_model: extra.model ?? MODEL, p_input_tokens: extra.inTok ?? null, p_output_tokens: extra.outTok ?? null,
    });

  const client = new Anthropic({ apiKey: key });
  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: userTurn(body.question, body.context) }],
    });
  } catch (e) {
    await finish('error');
    if (e instanceof Anthropic.RateLimitError) return reply(429, { error: 'Claude is busy. Try again in a minute.' });
    if (e instanceof Anthropic.AuthenticationError) return reply(503, { error: 'The Anthropic key was not accepted. Check the ANTHROPIC_API_KEY secret.' });
    if (e instanceof Anthropic.APIError) return reply(502, { error: `Claude could not answer (${e.status}).` });
    return reply(502, { error: 'Could not reach Claude.' });
  }
  const tokens = { inTok: msg.usage.input_tokens, outTok: msg.usage.output_tokens, model: msg.model };

  if (msg.stop_reason === 'refusal') {
    await finish('refused', tokens);
    return reply(200, { outcome: 'refused', message: 'No answer: Claude declined this question.' });
  }
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const answer = msg.stop_reason === 'max_tokens' ? null : parseAnswer(text);
  if (!answer || !answer.lines.length) {
    await finish('no_answer', tokens);
    return reply(200, { outcome: 'no_answer', message: 'No answer: the reply was not in the agreed form.' });
  }
  const check = checkLines(answer.lines, allowedRecords(body.context));
  if (!check.ok) {
    await finish('failed_check', { ...tokens, lines: answer.lines, cited: check.cited });
    return reply(200, { outcome: 'failed_check', message: 'No answer: it cited something it was not given, or a line had no source.', unknown: check.unknown });
  }
  const outcome = answer.answerable ? 'answered' : 'cannot_answer';
  await finish(outcome, { ...tokens, lines: answer.lines, cited: check.cited });
  return reply(200, { outcome, lines: answer.lines, cited: check.cited });
});
