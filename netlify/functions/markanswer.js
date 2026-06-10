const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callAI(prompt, maxTokens) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.Gemini_API_KEY;
  if (geminiKey) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) return text;
      }
    } catch (e) {
      console.error('Gemini error, falling back to Anthropic:', e.message);
    }
  }

  // Fallback: Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('No AI API key configured');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Anthropic API error');
  const data = await resp.json();
  return data?.content?.[0]?.text || '';
}

function parseJSON(raw, fallback) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return fallback; }
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);

    // ── SCRIBBLE MODE ─────────────────────────────────────────────────────────
    if (body._scribbleMode) {
      const { topic, keyTerms, bulletPoints, studentText, mode } = body;
      const modeLabel = mode === 'guided' ? 'Guided Recall (student read the content first)' : 'Free Recall (no prior reading)';
      const termsStr  = (keyTerms  || []).map(t => `• ${t.term}: ${t.def}`).join('\n');
      const pointsStr = (bulletPoints || []).map(p => `• ${p}`).join('\n');

      const prompt = `You are an AQA GCSE Science teacher marking a recall activity.

Topic: ${topic}
Mode: ${modeLabel}

Key terms the student should know:
${termsStr}

Key points the student should cover:
${pointsStr}

Student's recall:
"${studentText || '[Nothing written]'}"

Assess what the student recalled. Be encouraging but honest. Respond ONLY with a JSON object (no markdown):
{
  "pct": <integer 0-100, percentage of key content covered>,
  "covered": "<comma-separated list of key terms/points the student mentioned correctly>",
  "missed": "<comma-separated list of important points not mentioned>",
  "feedback": "<2-3 sentences of constructive, encouraging feedback for a GCSE student>",
  "tip": "<one specific revision tip based on what they missed>"
}`;

      const raw = await callAI(prompt, 600);
      const parsed = parseJSON(raw, { pct: 0, covered: '', missed: '', feedback: 'Marking could not be completed. Please try again.', tip: '' });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
    }

    // ── INSIGHT MODE ──────────────────────────────────────────────────────────
    if (body._insightMode) {
      const raw = await callAI(body.prompt, 300);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ insight: raw.trim() || 'Could not generate insight.' }) };
    }

    // ── REMARK MODE ───────────────────────────────────────────────────────────
    if (body._remarkMode) {
      const { term, correctAnswer, studentAnswer, reason, otherDetail } = body;
      const reasonStr = reason === 'Other' ? `Other: ${otherDetail || '(no detail provided)'}` : reason;
      const prompt = `You are an AQA GCSE Science teacher. A student has challenged a mark on a fill-in-the-blank or keyword question.

Question/term: "${term}"
Expected answer: "${correctAnswer}"
Student wrote: "${studentAnswer}"
Student's reason for challenge: "${reasonStr}"

Should the student's answer be awarded the mark? Consider:
- Minor spelling errors (1-2 letters off)
- Partial terms that are scientifically acceptable (e.g. "xylem" when answer is "xylem cells")
- Word order differences in multi-word answers
- Equivalent scientific terms or abbreviations
- The student's stated reason for the challenge

Be consistent with AQA GCSE marking — do not award marks for vague or incorrect answers, but do award for answers that demonstrate clear understanding despite minor differences.

Respond ONLY with JSON (no markdown): {"awarded": true or false, "reason": "<one sentence explanation>"}`;

      const raw = await callAI(prompt, 200);
      const parsed = parseJSON(raw, { awarded: false, reason: 'Could not process remark. Please try again.' });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
    }

    // ── SCAFFOLD MODE ─────────────────────────────────────────────────────────
    if (body._scaffoldMode) {
      const prompt = `You are an AQA GCSE Science teacher. A student is about to answer this exam question and needs vocabulary scaffolding — NOT a model answer.

Question: "${body.question}"
Command word: ${body.command_word || 'not specified'}
Marks available: ${body.marks}
Mark scheme: ${body.mark_scheme || 'not provided'}

Generate a JSON object with exactly this structure:
{
  "keyTerms": [
    { "term": "short scientific term (1-4 words)", "definition": "brief student-friendly definition (1 sentence)" }
  ],
  "starters": [
    "Question-specific sentence starter 1...",
    "Question-specific sentence starter 2...",
    "Question-specific sentence starter 3..."
  ]
}

Rules for keyTerms:
- ${body.marks} entries, one per mark
- Each term: a scientific keyword the student MUST include
- Definition must NOT give away the answer — help them recall the concept
- Terms are nouns/short noun phrases (e.g. "mitosis", "active transport", "concentration gradient")
- Definitions under 15 words; do NOT use the term in its own definition

Rules for starters:
- Exactly 3 starters, each tailored specifically to THIS question (not generic)
- Each starter begins a sentence the student could use to open their answer
- Each starter ends with "..." so students continue writing
- They must reference specific scientific content from the question (e.g. named cells, processes, structures)
- They must match the command word: ${body.command_word || 'describe/explain'}
- Do NOT complete the sentence — leave it open for the student

Respond ONLY with the JSON object.`;

      const raw = await callAI(prompt, 700);
      const parsed = parseJSON(raw, { keyTerms: [], starters: [] });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
    }

    // ── INTERIM MODE ──────────────────────────────────────────────────────────
    if (body._interimMode) {
      const prompt = `You are an AQA GCSE Science teacher giving mid-answer coaching to a student.

Question: "${body.question}"
Marks available: ${body.marks}
Mark scheme: ${body.mark_scheme || 'Use your AQA GCSE Biology knowledge'}
Command word: ${body.command_word || 'not specified'}

Student's answer so far:
"${body.student_answer || '[Nothing written yet]'}"

This is a PARTIAL answer — the student hasn't finished yet. Give brief, encouraging coaching.

Respond ONLY with JSON (no markdown):
{
  "covered": "<one sentence: what the student has correctly included so far>",
  "still_needed": "<one or two specific points still missing to get full marks>",
  "tip": "<one concrete suggestion for what to write next — be specific to this question>"
}`;

      const raw = await callAI(prompt, 300);
      const parsed = parseJSON(raw, { covered: '', still_needed: 'Could not analyse — try again.', tip: '' });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
    }

    // ── HINT MODE ─────────────────────────────────────────────────────────────
    if (body._hintMode) {
      const prompt = `You are an AQA GCSE Science teacher. A student is stuck on a question and needs a helpful nudge — NOT the answer.

Question: "${body.question}"
Marks: ${body.marks}
Command word: ${body.command_word || 'not specified'}

Give ONE sentence that steers the student in the right direction without giving away the answer. Focus on the key scientific concept or process they need to think about. Start with "Think about..." or "Consider...".`;

      const raw = await callAI(prompt, 120);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hint: raw.trim() || 'Think carefully about the key scientific concepts in this topic.' }) };
    }

    // ── MARKING MODE ──────────────────────────────────────────────────────────
    const { answers } = body;
    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No answers provided' }) };
    }

    const questionsText = answers.map((a, i) => `
Question ${i + 1}:
Question: ${a.question}
Marks available: ${a.marks}
Command word: ${a.command_word}
${a.mark_scheme ? `Mark scheme: ${a.mark_scheme}` : 'Use AQA GCSE Combined Science Biology knowledge to mark.'}
Student answer: "${a.student_answer || '[No answer given]'}"
${a.checked_steps && a.checked_steps.length ? `Student self-assessed these steps as completed: ${a.checked_steps.join('; ')}` : ''}
`).join('\n---\n');

    const prompt = `You are an AQA GCSE Biology examiner. Mark all of the following student answers. Mark leniently but fairly — reward understanding even if wording is not perfect.

${questionsText}

Respond ONLY with a JSON array with one object per question in this exact format (no markdown, no extra text):
[
  {
    "marks_awarded": <number>,
    "feedback": "<specific feedback on what was good and what was missing>",
    "missed_points": "<key points the student missed, if any>",
    "model_answer": "<a concise model answer>",
    "command_word_check": "<did the student answer the command word correctly?>"
  }
]`;

    const raw = await callAI(prompt, 2048);
    let parsed = parseJSON(raw, null);

    if (!parsed) {
      parsed = answers.map(() => ({ marks_awarded: 0, feedback: 'Marking could not be completed. Please try again.', missed_points: '', model_answer: '', command_word_check: '' }));
    }
    if (!Array.isArray(parsed)) parsed = [parsed];
    while (parsed.length < answers.length) {
      parsed.push({ marks_awarded: 0, feedback: 'Marking could not be completed for this question.', missed_points: '', model_answer: '', command_word_check: '' });
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
