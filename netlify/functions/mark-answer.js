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
