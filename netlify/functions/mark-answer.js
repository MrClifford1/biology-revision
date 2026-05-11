exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { prompt } = JSON.parse(event.body);

    if (!prompt) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No prompt provided' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log('API key present:', !!apiKey);
    console.log('API key length:', apiKey ? apiKey.length : 0);
    console.log('API key starts with:', apiKey ? apiKey.substring(0, 10) : 'none');

    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    console.log('Anthropic response status:', response.status);
    const responseText = await response.text();
    console.log('Anthropic response body:', responseText);

    if (!response.ok) {
      return { 
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marks_awarded: 0,
          feedback: `API error: ${response.status} - ${responseText.substring(0, 200)}`,
          missed_points: '',
          model_answer: '',
          command_word_check: '',
        }),
      };
    }

    const data = JSON.parse(responseText);
    const rawText = data?.content?.[0]?.text || '';

    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          marks_awarded: 0,
          feedback: 'Could not parse AI response: ' + cleaned.substring(0, 200),
          missed_points: '',
          model_answer: '',
          command_word_check: '',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        marks_awarded: 0,
        feedback: 'Function error: ' + err.message,
        missed_points: '',
        model_answer: '',
        command_word_check: ''
      }),
    };
  }
};
