exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    // ── SCRIBBLE MODE ─────────────────────────────────────────────────────────
    if (body._scribbleMode) {
      const { topic, keyTerms, bulletPoints, studentText, mode } = body;
      const modeLabel = mode === 'guided' ? 'Guided Recall (student read the content first)' : 'Free Recall (no prior reading)';
      const termsStr  = (keyTerms  || []).map(t => `• ${t.term}: ${t.def}`).join('\n');
      const pointsStr = (bulletPoints || []).map(p => `• ${p}`).join('\n');

      const scribblePrompt = `You are an AQA GCSE Science teacher marking a recall activity.

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

      const scribbleResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: scribblePrompt }] }),
      });
      if (!scribbleResp.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Scribble marking error' }) };
      const scribbleData = await scribbleResp.json();
      const rawScribble  = scribbleData?.content?.[0]?.text || '';
      const cleanScribble = rawScribble.replace(/```json|```/g, '').trim();
      let parsedScribble;
      try { parsedScribble = JSON.parse(cleanScribble); }
      catch(e) { parsedScribble = { pct: 0, covered: '', missed: '', feedback: 'Marking could not be completed. Please try again.', tip: '' }; }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsedScribble) };
    }

    // ── INSIGHT MODE ──────────────────────────────────────────────────────────
    if (body._insightMode) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: body.prompt }],
        }),
      });
      if (!response.ok) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Insight service error' }) };
      }
      const data = await response.json();
      const insight = data?.content?.[0]?.text || 'Could not generate insight.';
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insight }),
      };
    }

    // ── REMARK MODE ───────────────────────────────────────────────────────────
    if (body._remarkMode) {
      const { term, correctAnswer, studentAnswer, reason, otherDetail } = body;
      const reasonStr = reason === 'Other'
        ? `Other: ${otherDetail || '(no detail provided)'}`
        : reason;
      const remarkPrompt = `You are an AQA GCSE Science teacher. A student has challenged a mark on a fill-in-the-blank or keyword question.

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

      const remarkResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: remarkPrompt }] }),
      });
      if (!remarkResp.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Remark service error' }) };
      const remarkData = await remarkResp.json();
      const rawRemark = remarkData?.content?.[0]?.text || '';
      const cleanRemark = rawRemark.replace(/```json|```/g, '').trim();
      let parsedRemark;
      try { parsedRemark = JSON.parse(cleanRemark); }
      catch(e) { parsedRemark = { awarded: false, reason: 'Could not process remark. Please try again.' }; }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsedRemark) };
    }

    // ── MARKING MODE (existing logic) ─────────────────────────────────────────
    const { answers } = body;

    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No answers provided' }) };
    }

    // Build one prompt with ALL questions bundled together
    const questionsText = answers.map((a, i) => `
Question ${i + 1}:
Question: ${a.question}
Marks available: ${a.marks}
Command word: ${a.command_word}
${a.mark_scheme ? `Mark scheme: ${a.mark_scheme}` : 'Use AQA GCSE Combined Science Biology knowledge to mark.'}
Student answer: "${a.student_answer || '[No answer given]'}"
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Marking service error' }) };
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error:', cleaned);
      parsed = answers.map(() => ({
        marks_awarded: 0,
        feedback: 'Marking could not be completed. Please try again.',
        missed_points: '',
        model_answer: '',
        command_word_check: '',
      }));
    }

    // Ensure array matches length of answers
    if (!Array.isArray(parsed)) parsed = [parsed];
    while (parsed.length < answers.length) {
      parsed.push({
        marks_awarded: 0,
        feedback: 'Marking could not be completed for this question.',
        missed_points: '',
        model_answer: '',
        command_word_check: '',
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    };

  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
