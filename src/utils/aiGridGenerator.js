/**
 * AI Grid Generator
 * Generates Grid (Jeopardy-style) questions using Claude API via backend
 * Uses detailed prompts from original FloatingQuiz.jsx implementation
 */

import { getBackendUrl, apiFetch } from './backendUrl';

/**
 * Generate grid questions for a single category from a topic
 * @param {Object} options - Generation options
 * @param {string} options.categoryName - Category name
 * @param {string} options.topicName - Topic for this category
 * @param {number} options.difficultyYears - Years of experience (1-15)
 * @returns {Promise<Array>} 5 questions for this category (100-500 points)
 */
export async function generateCategoryFromTopic({ categoryName, topicName, difficultyYears = 5 }) {
  try {
    console.log('[AI Grid] Generating category from topic:', { categoryName, topicName, difficultyYears });

    const estimatedTokens = Math.max(3000, 5 * 300 + 1000);
    let aiSettings = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5@20250929',
      temperature: 0.3,
      maxTokens: estimatedTokens
    };

    if (window.electronAPI?.readEnvFile) {
      try {
        const envVars = await window.electronAPI.readEnvFile();
        const envMaxTokens = parseInt(envVars.DEFAULT_AI_MAX_TOKENS || estimatedTokens.toString());
        aiSettings = {
          provider: envVars.DEFAULT_AI_PROVIDER || 'anthropic',
          model: envVars.DEFAULT_AI_MODEL || 'claude-sonnet-4-5@20250929',
          temperature: 0.3,
          maxTokens: Math.max(envMaxTokens, estimatedTokens)
        };
      } catch (error) {
        console.warn('[AI Grid] Failed to load env settings:', error);
      }
    }

    // Define difficulty levels
    const difficulties = [
      { points: 100, level: 'Entry-level support engineers (1-2 years)', style: 'Basic concepts and fundamentals' },
      { points: 200, level: 'Junior-Mid support engineers (2-3 years)', style: 'Common procedures and terminology' },
      { points: 300, level: 'Mid-level support engineers (3-5 years)', style: 'Standard troubleshooting and configuration' },
      { points: 400, level: 'Senior support engineers (6-10 years)', style: 'Advanced troubleshooting and optimization' },
      { points: 500, level: 'Expert support engineers (10+ years)', style: 'Expert-level internals and edge cases' }
    ];

    const randomSeed = Math.floor(Math.random() * 1000000);
    const timestamp = Date.now();

    const prompt = `Generate exactly 5 technical Grid questions about "${topicName}" for Linux, cloud and Kubernetes support engineers.

[Session ID: ${randomSeed}-${timestamp}] - Generate unique questions each time.

CATEGORY: ${categoryName}
TOPIC: ${topicName}

YOUR TASK:
Generate 5 technical questions for a Grid game (1 per difficulty level), based on your knowledge of ${topicName}.

DIFFICULTY LEVELS:
- 100 points: ${difficulties[0].level} - ${difficulties[0].style}
- 200 points: ${difficulties[1].level} - ${difficulties[1].style}
- 300 points: ${difficulties[2].level} - ${difficulties[2].style}
- 400 points: ${difficulties[3].level} - ${difficulties[3].style}
- 500 points: ${difficulties[4].level} - ${difficulties[4].style}

**CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
- Maximum 3-4 words (preferably 1-2 words)
- Single technical term, command name, flag, parameter value, or specific value
- **NEVER list multiple items**
- Good examples: "kubelet", "etcd", "3", "bridge"
- Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long)

**CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
- If answer includes units (e.g., "10ms", "5GB"), include units in answer AND state in question: "(Include units)"
- If answer is JUST a number, question MUST say: "(Answer just number, not units)"
- ALWAYS use numeric digits (1, 2, 3) not words (one, two, three)

Return ONLY a valid JSON array with this exact structure (no markdown, no explanations):
[
  {
    "points": 100,
    "question": "Question appropriate for 100-point difficulty...",
    "answer": "short answer",
    "source": "Brief citation with URL if available (e.g., 'https://docs.example.com/...', 'man systemd.service(5)', 'Official documentation')"
  },
  {
    "points": 200,
    "question": "Question appropriate for 200-point difficulty...",
    "answer": "short answer",
    "source": "Brief citation with URL if available"
  },
  {
    "points": 300,
    "question": "Question appropriate for 300-point difficulty...",
    "answer": "short answer",
    "source": "Brief citation with URL if available"
  },
  {
    "points": 400,
    "question": "Question appropriate for 400-point difficulty...",
    "answer": "short answer",
    "source": "Brief citation with URL if available"
  },
  {
    "points": 500,
    "question": "Question appropriate for 500-point difficulty...",
    "answer": "short answer",
    "source": "Brief citation with URL if available"
  }
]

**ZERO-GUESSING PROTOCOL:**
- **SOURCE URLS MUST BE VALID:** If providing a URL in the source field, only use well-known, official documentation URLs that you know are real and accessible. Do not invent or guess URLs. If uncertain about a URL, provide a non-URL citation instead.
- Only generate questions about facts you are absolutely certain of
- If uncertain about the topic, respond with "INSUFFICIENT_KNOWLEDGE: [explanation]"

Questions must be progressively harder based on difficulty points.

Generate exactly 5 questions (1 per difficulty level: 100, 200, 300, 400, 500).`;

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      })
    });

    if (!response.ok) {
      throw new Error('Failed to get AI response from backend');
    }

    const data = await response.json();
    const aiResponse = data.message;

    console.log('[AI Grid] Received response, parsing...');

    // Check for insufficient knowledge
    if (aiResponse.includes('INSUFFICIENT_KNOWLEDGE')) {
      throw new Error('AI cannot generate questions for this topic with 100% accuracy');
    }

    // Parse the response
    let parsedResponse;
    try {
      let cleanedResponse = aiResponse.trim();
      if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      }

      // Find JSON array
      if (!cleanedResponse.startsWith('[')) {
        const arrayStart = cleanedResponse.indexOf('[');
        if (arrayStart !== -1) {
          cleanedResponse = cleanedResponse.substring(arrayStart);
        }
      }

      const arrayEnd = cleanedResponse.lastIndexOf(']');
      if (arrayEnd !== -1 && arrayEnd < cleanedResponse.length - 1) {
        cleanedResponse = cleanedResponse.substring(0, arrayEnd + 1);
      }

      parsedResponse = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('[AI Grid] Failed to parse AI response:', parseError);
      throw new Error('Failed to parse AI response. Please try again.');
    }

    if (!Array.isArray(parsedResponse) || parsedResponse.length !== 5) {
      console.warn('[AI Grid] Expected 5 questions, got', parsedResponse?.length);
      if (parsedResponse.length === 0) {
        throw new Error('No questions generated');
      }
    }

    console.log('[AI Grid] Successfully generated', parsedResponse.length, 'questions for category');
    return parsedResponse;

  } catch (error) {
    console.error('[AI Grid] Category generation failed:', error);
    throw error;
  }
}

/**
 * Generate grid questions for a single category from a URL
 */
export async function generateCategoryFromURL({ categoryName, url, urlTopic = '' }) {
  try {
    console.log('[AI Grid] Generating category from URL:', { categoryName, url, urlTopic });

    // Fetch the URL content first
    console.log('[AI Grid] Fetching URL content...');
    let urlContent;
    try {
      const backendUrl = await getBackendUrl();
      const fetchResponse = await apiFetch(`${backendUrl}/api/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!fetchResponse.ok) {
        throw new Error(`Failed to fetch URL: ${fetchResponse.statusText}`);
      }

      const fetchData = await fetchResponse.json();
      urlContent = fetchData.content || fetchData.text || '';

      if (!urlContent || urlContent.trim().length < 100) {
        throw new Error('URL content is too short or empty. The page may require JavaScript or authentication.');
      }

      console.log('[AI Grid] Fetched URL content:', urlContent.length, 'characters');
    } catch (fetchError) {
      console.error('[AI Grid] Failed to fetch URL:', fetchError);
      throw new Error(`Cannot access URL: ${fetchError.message}. Make sure the URL is publicly accessible and doesn't require authentication.`);
    }

    const estimatedTokens = Math.max(4000, 5 * 300 + 1500);
    let aiSettings = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5@20250929',
      temperature: 0.3,
      maxTokens: estimatedTokens
    };

    if (window.electronAPI?.readEnvFile) {
      try {
        const envVars = await window.electronAPI.readEnvFile();
        const envMaxTokens = parseInt(envVars.DEFAULT_AI_MAX_TOKENS || estimatedTokens.toString());
        aiSettings = {
          provider: envVars.DEFAULT_AI_PROVIDER || 'anthropic',
          model: envVars.DEFAULT_AI_MODEL || 'claude-sonnet-4-5@20250929',
          temperature: 0.3,
          maxTokens: Math.max(envMaxTokens, estimatedTokens)
        };
      } catch (error) {
        console.warn('[AI Grid] Failed to load env settings:', error);
      }
    }

    const difficulties = [
      { points: 100, level: 'Entry-level support engineers (1-2 years)', style: 'Basic concepts and fundamentals' },
      { points: 200, level: 'Junior-Mid support engineers (2-3 years)', style: 'Common procedures and terminology' },
      { points: 300, level: 'Mid-level support engineers (3-5 years)', style: 'Standard troubleshooting and configuration' },
      { points: 400, level: 'Senior support engineers (6-10 years)', style: 'Advanced troubleshooting and optimization' },
      { points: 500, level: 'Expert support engineers (10+ years)', style: 'Expert-level internals and edge cases' }
    ];

    const prompt = `You are creating technical Grid questions for Linux, cloud and Kubernetes support engineers based on documentation.

DOCUMENTATION SOURCE: ${url}
CATEGORY: ${categoryName}
${urlTopic ? 'FOCUS TOPIC: ' + urlTopic : ''}

DOCUMENTATION CONTENT:
${urlContent}

YOUR TASK:
1. Read and understand the documentation content above
2. Generate exactly 5 technical questions for a Grid game (1 per difficulty level)${urlTopic ? `, focusing on ${urlTopic}` : ''}

DIFFICULTY LEVELS:
- 100 points: ${difficulties[0].level} - ${difficulties[0].style}
- 200 points: ${difficulties[1].level} - ${difficulties[1].style}
- 300 points: ${difficulties[2].level} - ${difficulties[2].style}
- 400 points: ${difficulties[3].level} - ${difficulties[3].style}
- 500 points: ${difficulties[4].level} - ${difficulties[4].style}

**CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
- Maximum 3-4 words (preferably 1-2 words)
- Single technical term, command name, flag, parameter value, or specific value
- **NEVER list multiple items**
- Good examples: "kubelet", "etcd", "3", "bridge"
- Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long)

**CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
- If answer includes units (e.g., "10ms", "5GB"), include units in answer AND state in question: "(Include units)"
- If answer is JUST a number, question MUST say: "(Answer just number, not units)"
- ALWAYS use numeric digits (1, 2, 3) not words (one, two, three)

Return ONLY a valid JSON array with this exact structure (no markdown, no explanations):
[
  {
    "points": 100,
    "question": "Question based on the documentation...",
    "answer": "short answer",
    "source": "Brief citation (section name or specific location from ${url})"
  },
  {
    "points": 200,
    "question": "Question based on the documentation...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 300,
    "question": "Question based on the documentation...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 400,
    "question": "Question based on the documentation...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 500,
    "question": "Question based on the documentation...",
    "answer": "short answer",
    "source": "Brief citation"
  }
]

**ZERO-GUESSING PROTOCOL - CRITICAL:**
- **DOCUMENTATION ONLY**: Every fact MUST come DIRECTLY from the documentation at the URL
- **EXPLICIT ONLY**: If not explicitly written in the documentation, DO NOT create a question about it
- **WORD-FOR-WORD VERIFICATION**: Locate the exact sentence containing the answer before finalizing
- If documentation is too sparse for 5 questions, respond with "INSUFFICIENT_DOCUMENTATION: [explanation]"

Questions must be progressively harder based on difficulty points.

Generate exactly 5 questions (1 per difficulty level: 100, 200, 300, 400, 500).`;

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      })
    });

    if (!response.ok) {
      throw new Error('Failed to get AI response from backend');
    }

    const data = await response.json();
    let aiResponse = data.message;

    console.log('[AI Grid] 📄 Raw AI Response (first 500 chars):');
    console.log(aiResponse.substring(0, 500));

    if (aiResponse.includes('INSUFFICIENT_DOCUMENTATION')) {
      throw new Error('Documentation is too sparse to generate questions from it. AI stated: ' + aiResponse.substring(0, 200));
    }

    // Extract JSON from response - try markdown code blocks first
    const markdownMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      console.log('[AI Grid] ✂️  Extracted JSON from markdown code block');
      aiResponse = markdownMatch[1];
    }

    let cleanedResponse = aiResponse.trim();
    if (!cleanedResponse.startsWith('[')) {
      const arrayStart = cleanedResponse.indexOf('[');
      if (arrayStart !== -1) {
        console.log('[AI Grid] ✂️  Found array start at position', arrayStart);
        cleanedResponse = cleanedResponse.substring(arrayStart);
      }
    }

    const arrayEnd = cleanedResponse.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd < cleanedResponse.length - 1) {
      console.log('[AI Grid] ✂️  Trimming content after array end');
      cleanedResponse = cleanedResponse.substring(0, arrayEnd + 1);
    }

    console.log('[AI Grid] 🔧 Cleaned response length:', cleanedResponse.length, 'chars');

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('[AI Grid] ❌ JSON Parse Error:', parseError.message);
      console.error('[AI Grid] 📋 Failed to parse this content:');
      console.error(cleanedResponse.substring(0, 1000));
      throw new Error(`Failed to parse AI response: ${parseError.message}. The AI may have returned malformed JSON.`);
    }

    if (!Array.isArray(parsedResponse) || parsedResponse.length === 0) {
      throw new Error('Invalid response format from AI - expected array of 5 questions, got: ' + typeof parsedResponse);
    }

    console.log('[AI Grid] ✅ Generated', parsedResponse.length, 'questions from URL (expected 5)');

    if (parsedResponse.length < 5) {
      console.warn('[AI Grid] ⚠️  Only received', parsedResponse.length, 'questions instead of 5!');
    }

    return parsedResponse;

  } catch (error) {
    console.error('[AI Grid] URL generation failed:', error);
    throw error;
  }
}

/**
 * Generate grid questions for a single category from a file
 */
export async function generateCategoryFromFile({ categoryName, file, fileTopic = '' }) {
  try {
    console.log('[AI Grid] Generating category from file:', { categoryName, fileName: file.name, fileTopic });

    // Read file content
    const fileContent = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });

    const estimatedTokens = Math.max(4000, 5 * 300 + 1500);
    let aiSettings = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5@20250929',
      temperature: 0.3,
      maxTokens: estimatedTokens
    };

    if (window.electronAPI?.readEnvFile) {
      try {
        const envVars = await window.electronAPI.readEnvFile();
        const envMaxTokens = parseInt(envVars.DEFAULT_AI_MAX_TOKENS || estimatedTokens.toString());
        aiSettings = {
          provider: envVars.DEFAULT_AI_PROVIDER || 'anthropic',
          model: envVars.DEFAULT_AI_MODEL || 'claude-sonnet-4-5@20250929',
          temperature: 0.3,
          maxTokens: Math.max(envMaxTokens, estimatedTokens)
        };
      } catch (error) {
        console.warn('[AI Grid] Failed to load env settings:', error);
      }
    }

    const difficulties = [
      { points: 100, level: 'Entry-level support engineers (1-2 years)', style: 'Basic concepts and fundamentals' },
      { points: 200, level: 'Junior-Mid support engineers (2-3 years)', style: 'Common procedures and terminology' },
      { points: 300, level: 'Mid-level support engineers (3-5 years)', style: 'Standard troubleshooting and configuration' },
      { points: 400, level: 'Senior support engineers (6-10 years)', style: 'Advanced troubleshooting and optimization' },
      { points: 500, level: 'Expert support engineers (10+ years)', style: 'Expert-level internals and edge cases' }
    ];

    const prompt = `You are creating technical Grid questions for Linux, cloud and Kubernetes support engineers.

CATEGORY: ${categoryName}
${fileTopic ? 'FOCUS TOPIC: ' + fileTopic : ''}

CONTENT:
${fileContent}

YOUR TASK:
Generate exactly 5 technical questions for a Grid game (1 per difficulty level) based on the content above.

DIFFICULTY LEVELS:
- 100 points: ${difficulties[0].level} - ${difficulties[0].style}
- 200 points: ${difficulties[1].level} - ${difficulties[1].style}
- 300 points: ${difficulties[2].level} - ${difficulties[2].style}
- 400 points: ${difficulties[3].level} - ${difficulties[3].style}
- 500 points: ${difficulties[4].level} - ${difficulties[4].style}

**CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
- Maximum 3-4 words (preferably 1-2 words)
- Single technical term, command name, flag, parameter value, or specific value
- **NEVER list multiple items**
- Good examples: "kubelet", "etcd", "3", "bridge"
- Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long)

**CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
- If answer includes units (e.g., "10ms", "5GB"), include units in answer AND state in question: "(Include units)"
- If answer is JUST a number, question MUST say: "(Answer just number, not units)"
- ALWAYS use numeric digits (1, 2, 3) not words (one, two, three)

Return ONLY a valid JSON array with this exact structure (no markdown, no explanations):
[
  {
    "points": 100,
    "question": "Question based on the content...",
    "answer": "short answer",
    "source": "Brief citation (section name, chapter, or page reference)"
  },
  {
    "points": 200,
    "question": "Question based on the content...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 300,
    "question": "Question based on the content...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 400,
    "question": "Question based on the content...",
    "answer": "short answer",
    "source": "Brief citation"
  },
  {
    "points": 500,
    "question": "Question based on the content...",
    "answer": "short answer",
    "source": "Brief citation"
  }
]

**ZERO-GUESSING PROTOCOL - CRITICAL:**
- **CONTENT ONLY**: Every fact MUST come DIRECTLY from the content above
- **EXPLICIT ONLY**: If not explicitly written, DO NOT create a question about it
- If content is too sparse for 5 questions, respond with "INSUFFICIENT_DOCUMENTATION: [explanation]"

Questions must be progressively harder based on difficulty points.

Generate exactly 5 questions (1 per difficulty level: 100, 200, 300, 400, 500).`;

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      })
    });

    if (!response.ok) {
      throw new Error('Failed to get AI response from backend');
    }

    const data = await response.json();
    let aiResponse = data.message;

    if (aiResponse.includes('INSUFFICIENT_DOCUMENTATION')) {
      throw new Error('File content is too sparse to generate questions');
    }

    let cleanedResponse = aiResponse.trim();
    if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    if (!cleanedResponse.startsWith('[')) {
      const arrayStart = cleanedResponse.indexOf('[');
      if (arrayStart !== -1) {
        cleanedResponse = cleanedResponse.substring(arrayStart);
      }
    }

    const arrayEnd = cleanedResponse.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd < cleanedResponse.length - 1) {
      cleanedResponse = cleanedResponse.substring(0, arrayEnd + 1);
    }

    const parsedResponse = JSON.parse(cleanedResponse);
    if (!Array.isArray(parsedResponse) || parsedResponse.length === 0) {
      throw new Error('Invalid response format from AI');
    }

    console.log('[AI Grid] Generated', parsedResponse.length, 'questions from file');
    return parsedResponse;

  } catch (error) {
    console.error('[AI Grid] File generation failed:', error);
    throw error;
  }
}
