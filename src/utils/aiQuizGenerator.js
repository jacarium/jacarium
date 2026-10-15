/**
 * AI Quiz Generator
 * Generates quiz questions using Claude API via backend
 * Uses detailed prompts from original FloatingQuiz.jsx implementation
 */

import { getBackendUrl, apiFetch } from './backendUrl';

/**
 * Generate quiz questions using AI
 * @param {Object} options - Generation options
 * @param {string} options.topic - Topic name or description
 * @param {number} options.numQuestions - Number of questions to generate
 * @param {number} options.difficultyYears - Years of experience (1-15)
 * @returns {Promise<Array>} Array of quiz questions
 */
export async function generateAIQuizQuestions({ topic, numQuestions = 10, difficultyYears = 5 }) {
  try {
    console.log('[AI Quiz] Generating questions:', { topic, numQuestions, difficultyYears });

    // Load AI settings from environment
    const estimatedTokens = Math.max(4000, numQuestions * 500 + 1000);
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
        console.log('[AI Quiz] Using AI settings:', aiSettings);
      } catch (error) {
        console.warn('[AI Quiz] Failed to load env settings, using defaults:', error);
      }
    }

    // Determine target audience and focus
    let targetAudience, focusAreas;

    if (difficultyYears <= 2) {
      targetAudience = 'Entry-level developers and beginners';
      focusAreas = `- Basic concepts and fundamentals
- Common use cases and basic syntax
- Getting started tutorials
- Basic terminology and definitions
- Simple troubleshooting
- Foundational knowledge`;
    } else if (difficultyYears <= 5) {
      targetAudience = 'Mid-level developers';
      focusAreas = `- Common patterns and best practices
- Practical use cases
- Standard configuration
- Common troubleshooting
- Core features and applications
- Moderate depth concepts`;
    } else if (difficultyYears <= 10) {
      targetAudience = 'Senior engineers';
      focusAreas = `- Advanced features and optimization
- Complex troubleshooting
- Architecture and design patterns
- Performance tuning
- Production considerations
- Internal workings`;
    } else {
      targetAudience = 'Expert-level engineers and architects';
      focusAreas = `- Advanced features and edge cases
- Performance optimization
- Complex debugging scenarios
- Internal architecture details
- Production best practices
- Security considerations
- Deep technical internals`;
    }

    const randomSeed = Math.floor(Math.random() * 1000000);
    const timestamp = Date.now();

    const prompt = `Generate exactly ${numQuestions} quiz questions about "${topic}" for ${targetAudience} with ${difficultyYears}+ years of experience.

[Session ID: ${randomSeed}-${timestamp}] - Generate unique questions each time.

Target audience: ${targetAudience} who work with ${topic}.

Focus on:
${focusAreas}

Return ONLY a valid JSON array with this exact structure (no additional text, no markdown, no explanations):
[
  {
    "id": "q1",
    "question": "What system call...",
    "answer": "short answer",
    "hints": ["hint 1", "hint 2", "hint 3"],
    "category": "${topic}",
    "source": "Brief citation with URL if available (e.g., 'https://man7.org/linux/man-pages/man5/systemd.service.5.html', 'man systemd.service(5)', 'RFC 793 - TCP Specification')"
  }
]

Requirements:
- Exactly ${numQuestions} questions appropriate for ${difficultyYears}+ years of experience
- **CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
  * Maximum 3-4 words (preferably 1-2 words)
  * Single technical term, command name, flag, or specific value
  * **NEVER list multiple items** (e.g., NO "platform1, platform2, platform3")
  * **NEVER ask "what are the X things"** - instead ask about ONE specific thing
  * Good examples: "kubectl", "tmpfs", "3", "bridge mode", "etcd"
  * Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long, multiple items)
- Questions should match the experience level of the target audience
- Each question must have exactly 3 hints that progressively reveal the answer
- First hint should be subtle, third hint should almost give it away
- IMPORTANT: If the answer has a commonly used acronym, include BOTH the full term and acronym using "or" format
  Examples: "VirtualMachineInstance or VMI", "Continuous Integration or CI", "API or Application Programming Interface"
- For numeric range answers, use "X to Y" format (e.g., "10 to 25", "5 to 10")
  Users can answer with any number in the range or the full range itself
- **CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
  * If answer is a number WITH units (e.g., "10ms", "5GB", "30 seconds"), include units in the answer AND explicitly state in question: "(Include units)"
  * If answer is JUST a number (no units), question MUST say: "(Answer just number, not units)"
  * ALWAYS use numeric digits (1, 2, 3) instead of words (one, two, three) for numeric answers
  * Examples:
    - "What is the default timeout for HTTP requests? (Include units)" → answer: "30 seconds" or "30s"
    - "How many worker threads does the default pool use? (Answer just number, not units)" → answer: "10"
    - WRONG: "How many control plane nodes are required for High Availability?" → answer: "three" (should be "3")

**ZERO-GUESSING PROTOCOL - CRITICAL:**
- VERIFICATION CHECK: Before finalizing any question, verify the fact against your knowledge base. If you are not 100% certain of a specific name, command, flag, value, or detail, DISCARD the question and pick a different topic.
- EXPLICIT CITATIONS: Every answer must be supported by a real-world, verifiable fact. NO HALLUCINATIONS.
- **SOURCE URLS MUST BE VALID:** If providing a URL in the source field, only use well-known, official documentation URLs that you know are real and accessible (e.g., man7.org, kernel.org, RFCs, official project docs). Do not invent or guess URLs. If uncertain about a URL, provide a non-URL citation instead (e.g., "RFC 793", "man systemd(1)", "Official documentation").
- If the topic is too niche or you cannot guarantee 100% accuracy for all questions, state "INSUFFICIENT_KNOWLEDGE" and explain which aspects are uncertain.
- Only generate questions about facts you are absolutely certain of.
- Prefer well-documented, commonly-known facts over obscure edge cases where accuracy cannot be guaranteed.

- Return ONLY the JSON array, nothing else`;

    console.log('[AI Quiz] Sending request to AI...');

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

    console.log('[AI Quiz] 📄 Raw AI Response (first 500 chars):');
    console.log(aiResponse.substring(0, 500));

    // Check if AI indicated insufficient knowledge
    if (aiResponse.includes('INSUFFICIENT_KNOWLEDGE')) {
      throw new Error('AI cannot generate quiz with 100% accuracy for this topic. The AI stated: ' + aiResponse.substring(0, 200));
    }

    // Try to extract JSON from the response
    // Sometimes AI returns markdown code blocks
    const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/) ||
                     aiResponse.match(/```\s*([\s\S]*?)\s*```/) ||
                     aiResponse.match(/\[([\s\S]*)\]/);

    if (jsonMatch) {
      console.log('[AI Quiz] ✂️  Extracted JSON from markdown code block');
      aiResponse = jsonMatch[1] || jsonMatch[0];
    }

    // Clean up the response
    aiResponse = aiResponse.trim();
    if (!aiResponse.startsWith('[')) {
      const arrayStart = aiResponse.indexOf('[');
      if (arrayStart !== -1) {
        console.log('[AI Quiz] ✂️  Found array start at position', arrayStart);
        aiResponse = aiResponse.substring(arrayStart);
      }
    }

    // Find where the JSON array ends
    const arrayEnd = aiResponse.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd < aiResponse.length - 1) {
      console.log('[AI Quiz] ✂️  Trimming content after array end');
      aiResponse = aiResponse.substring(0, arrayEnd + 1);
    }

    console.log('[AI Quiz] 🔧 Cleaned response (first 500 chars):');
    console.log(aiResponse.substring(0, 500));
    console.log('[AI Quiz] 🔧 Response length:', aiResponse.length, 'chars');

    let questions;
    try {
      questions = JSON.parse(aiResponse);
    } catch (parseError) {
      console.error('[AI Quiz] ❌ JSON Parse Error:', parseError.message);
      console.error('[AI Quiz] 📋 Failed to parse this content:');
      console.error(aiResponse.substring(0, 1000));
      throw new Error(`Failed to parse AI response: ${parseError.message}. The AI may have returned malformed JSON.`);
    }

    console.log('[AI Quiz] 📦 AI Response:');
    console.log('  Raw questions received:', questions.length);

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('AI did not return a valid question array');
    }

    // Validate and clean questions
    const validQuestions = questions.filter(q =>
      q.question && q.answer && Array.isArray(q.hints) && q.hints.length >= 3
    ).map((q, index) => ({
      id: q.id || `ai-${index + 1}`,
      question: q.question,
      answer: q.answer,
      hints: q.hints.slice(0, 3),
      category: q.category || topic,
      source: q.source || 'General knowledge'
    }));

    console.log('  Valid questions after filtering:', validQuestions.length);

    if (validQuestions.length === 0) {
      throw new Error('No valid questions generated');
    }

    console.log('[AI Quiz] Successfully generated', validQuestions.length, 'questions');
    return validQuestions;

  } catch (error) {
    console.error('[AI Quiz] Generation failed:', error);
    throw error;
  }
}

/**
 * Generate quiz questions from a document URL
 */
export async function generateQuizFromURL({ url, focusTopic = '', numQuestions = 10, difficultyYears = 5 }) {
  try {
    console.log('[AI Quiz] Generating from URL:', url);

    // Fetch the URL content first
    console.log('[AI Quiz] Fetching URL content...');
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

      console.log('[AI Quiz] Fetched URL content:', urlContent.length, 'characters');
    } catch (fetchError) {
      console.error('[AI Quiz] Failed to fetch URL:', fetchError);
      throw new Error(`Cannot access URL: ${fetchError.message}. Make sure the URL is publicly accessible and doesn't require authentication.`);
    }

    const estimatedTokens = Math.max(6000, numQuestions * 500 + 2000);
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
        console.warn('[AI Quiz] Failed to load env settings:', error);
      }
    }

    // Determine target audience and question style
    let targetAudience, questionStyle;
    if (difficultyYears <= 2) {
      targetAudience = 'Junior engineers and beginners (0-2 years)';
      questionStyle = `- Basic concepts and fundamentals
- Common terminology
- Getting started procedures
- Basic commands and their syntax
- Simple configuration parameters`;
    } else if (difficultyYears <= 5) {
      targetAudience = 'Mid-level engineers (3-5 years)';
      questionStyle = `- Practical use cases and common scenarios
- Standard troubleshooting procedures
- Configuration best practices
- Common commands with flags and options
- Understanding of architecture basics`;
    } else if (difficultyYears <= 10) {
      targetAudience = 'Senior engineers (6-10 years)';
      questionStyle = `- Advanced configuration and tuning
- Complex troubleshooting scenarios
- Performance optimization techniques
- Deep understanding of internals
- Production best practices`;
    } else {
      targetAudience = 'Expert support engineers and specialists (10+ years)';
      questionStyle = `- Expert-level troubleshooting and edge cases
- Advanced internals and architecture details
- Complex production scenarios
- Performance optimization and tuning parameters
- Deep technical knowledge and specialized topics
- Advanced command-line options and flags`;
    }

    const prompt = `You are creating a technical quiz based on documentation.

DOCUMENTATION SOURCE: ${url}
TARGET AUDIENCE: ${targetAudience}
${focusTopic ? `FOCUS TOPIC: ${focusTopic} - Generate questions specifically about this topic from the documentation` : ''}

DOCUMENTATION CONTENT:
${urlContent}

YOUR TASK:
1. Read and deeply understand the documentation content above
2. Identify the key technical concepts, procedures, commands, and troubleshooting steps${focusTopic ? ` related to "${focusTopic}"` : ''}
3. Generate exactly ${numQuestions} sophisticated quiz questions that test real understanding of this documentation${focusTopic ? `, focusing on ${focusTopic}` : ''}

QUESTION STYLE:
${questionStyle}

IMPORTANT REQUIREMENTS:
- Questions MUST be based on specific information found in the documentation
- Test understanding, not just memorization
- Include questions about:
  * Specific commands and their flags/options
  * Configuration parameters and their values
  * Troubleshooting procedures and steps
  * Technical concepts and how they work
  * When to use specific features or approaches
- Avoid generic questions - make them specific to the documentation content
- **CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
  * Maximum 3-4 words (preferably 1-2 words)
  * Single technical term, command name, flag, parameter value, or specific value
  * **NEVER list multiple items** (e.g., NO "platform1, platform2, platform3")
  * **NEVER ask "what are the X things"** - instead ask about ONE specific thing
  * Good examples: "kubelet", "etcd", "3", "bridge"
  * Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long, multiple items)
- If the documentation mentions specific values, commands, or flags, use those in questions
- **CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
  * If answer is a number WITH units (e.g., "10ms", "5GB"), include units in the answer AND explicitly state in question: "(Include units)"
  * If answer is JUST a number (no units), question MUST say: "(Answer just number, not units)"
  * ALWAYS use numeric digits (1, 2, 3) instead of words (one, two, three) for numeric answers
  * Examples:
    - "What is the default timeout? (Include units)" → answer: "10ms"
    - "How many CPUs are recommended? (Answer just number, not units)" → answer: "4"
    - WRONG: "How many control plane nodes are required for High Availability?" → answer: "three" (should be "3")

Return ONLY a valid JSON array with this exact structure (no markdown, no explanations):
[
  {
    "id": "q1",
    "question": "Specific question based on the documentation...",
    "answer": "short specific answer",
    "hints": ["subtle hint", "moderate hint", "almost gives it away"],
    "category": "Documentation",
    "source": "Brief citation with URL if available (e.g., '${url}#section', 'Section 3.2')"
  }
]

HINT REQUIREMENTS:
- Each question must have exactly 3 progressive hints
- First hint: Subtle, points to the general area
- Second hint: More specific, narrows it down
- Third hint: Almost reveals the answer
- For acronyms, include both full term and acronym in answer using "or" format (e.g., "Virtual Machine or VM")

**ZERO-GUESSING PROTOCOL - CRITICAL:**
- **DOCUMENTATION ONLY**: Every single fact in every question and answer MUST come DIRECTLY from the documentation. Do NOT use external knowledge, common practices, or standard conventions unless they are explicitly mentioned in this documentation.
- **EXPLICIT ONLY**: If a fact, command, value, or procedure is not explicitly written in the documentation text, DO NOT create a question about it. "Derivable" or "implied" is NOT sufficient.
- **WORD-FOR-WORD VERIFICATION**: Before finalizing each question, locate the exact sentence or paragraph in the documentation that contains the answer. If you cannot find it word-for-word, do not include that question.
- **SOURCE URLS MUST BE VALID:** Only use URLs that are explicitly mentioned in the documentation. Never invent, guess, or use memorized URLs. If uncertain, use non-URL citation (e.g., "Section 3.2").
- **INSUFFICIENT DOCUMENTATION**: If the documentation is too sparse to generate ${numQuestions} high-quality, explicitly-verified questions, respond with "INSUFFICIENT_DOCUMENTATION: [explanation]" instead of making up content.
- **NO EXTERNAL KNOWLEDGE**: Do not fill gaps with your training data. If the documentation doesn't mention a standard practice, pretend you don't know it.

Generate exactly ${numQuestions} questions that demonstrate deep understanding of this documentation.`;

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

    console.log('[AI Quiz] 📄 Raw AI Response:');
    console.log('  Total length:', aiResponse.length, 'chars');

    // Check if AI indicated insufficient documentation
    if (aiResponse.includes('INSUFFICIENT_DOCUMENTATION')) {
      throw new Error('AI cannot generate quiz from this documentation. The documentation may be too sparse or unclear. AI stated: ' + aiResponse.substring(0, 200));
    }

    // Extract JSON from response - try markdown code blocks first
    const markdownMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      console.log('[AI Quiz] ✂️  Extracted JSON from markdown code block');
      aiResponse = markdownMatch[1];
    }

    // Clean up the response
    aiResponse = aiResponse.trim();
    if (!aiResponse.startsWith('[')) {
      const arrayStart = aiResponse.indexOf('[');
      if (arrayStart !== -1) {
        aiResponse = aiResponse.substring(arrayStart);
      }
    }

    const arrayEnd = aiResponse.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd < aiResponse.length - 1) {
      aiResponse = aiResponse.substring(0, arrayEnd + 1);
    }

    let questions;
    try {
      questions = JSON.parse(aiResponse);
    } catch (parseError) {
      console.error('[AI Quiz] ❌ JSON Parse Error:', parseError.message);
      throw new Error(`Failed to parse AI response: ${parseError.message}`);
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('AI did not return a valid question array');
    }

    // Validate and clean questions
    const validQuestions = questions.filter(q =>
      q.question && q.answer && Array.isArray(q.hints) && q.hints.length >= 3
    ).map((q, index) => ({
      id: q.id || `url-${index + 1}`,
      question: q.question,
      answer: q.answer,
      hints: q.hints.slice(0, 3),
      category: q.category || 'Documentation',
      source: q.source || url
    }));

    console.log('[AI Quiz] Generated', validQuestions.length, 'questions from URL');
    return validQuestions;

  } catch (error) {
    console.error('[AI Quiz] URL generation failed:', error);
    throw error;
  }
}

/**
 * Generate quiz questions from a file
 */
export async function generateQuizFromFile({ file, focusTopic = '', numQuestions = 10, difficultyYears = 5 }) {
  try {
    console.log('[AI Quiz] Generating from file:', file.name);

    // Read file content
    const fileContent = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });

    const estimatedTokens = Math.max(6000, numQuestions * 500 + 2000);
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
        console.warn('[AI Quiz] Failed to load env settings:', error);
      }
    }

    // Same target audience and question style as URL
    let targetAudience, questionStyle;
    if (difficultyYears <= 2) {
      targetAudience = 'Junior engineers and beginners (0-2 years)';
      questionStyle = `- Basic concepts and fundamentals
- Common terminology
- Getting started procedures
- Basic commands and their syntax
- Simple configuration parameters`;
    } else if (difficultyYears <= 5) {
      targetAudience = 'Mid-level engineers (3-5 years)';
      questionStyle = `- Practical use cases and common scenarios
- Standard troubleshooting procedures
- Configuration best practices
- Common commands with flags and options
- Understanding of architecture basics`;
    } else if (difficultyYears <= 10) {
      targetAudience = 'Senior engineers (6-10 years)';
      questionStyle = `- Advanced configuration and tuning
- Complex troubleshooting scenarios
- Performance optimization techniques
- Deep understanding of internals
- Production best practices`;
    } else {
      targetAudience = 'Expert support engineers and specialists (10+ years)';
      questionStyle = `- Expert-level troubleshooting and edge cases
- Advanced internals and architecture details
- Complex production scenarios
- Performance optimization and tuning parameters
- Deep technical knowledge and specialized topics
- Advanced command-line options and flags`;
    }

    const prompt = `You are creating a technical quiz based on documentation content.

DOCUMENTATION TITLE: ${file.name}
TARGET AUDIENCE: ${targetAudience}
${focusTopic ? `FOCUS TOPIC: ${focusTopic} - Generate questions specifically about this topic from the documentation` : ''}

DOCUMENTATION CONTENT:
${fileContent}

YOUR TASK:
1. Read and deeply understand the documentation above
2. Identify the key technical concepts, procedures, commands, and troubleshooting steps${focusTopic ? ` related to "${focusTopic}"` : ''}
3. Generate exactly ${numQuestions} sophisticated quiz questions that test real understanding of this documentation${focusTopic ? `, focusing on ${focusTopic}` : ''}

QUESTION STYLE:
${questionStyle}

IMPORTANT REQUIREMENTS:
- Questions MUST be based on specific information found in the documentation
- Test understanding, not just memorization
- **CRITICAL - ANSWER LENGTH:** Each answer MUST be SHORT and TYPEABLE:
  * Maximum 3-4 words (preferably 1-2 words)
  * Single technical term, command name, flag, parameter value, or specific value
  * **NEVER list multiple items** (e.g., NO "platform1, platform2, platform3")
  * **NEVER ask "what are the X things"** - instead ask about ONE specific thing
  * Good examples: "kubelet", "etcd", "3", "bridge"
  * Bad examples: "AWS Bare-metal, On-premise, IBM Cloud" (too long, multiple items)
- **CRITICAL FOR NUMERIC ANSWERS WITH UNITS:**
  * If answer is a number WITH units (e.g., "10ms", "5GB"), include units in the answer AND explicitly state in question: "(Include units)"
  * If answer is JUST a number (no units), question MUST say: "(Answer just number, not units)"
  * ALWAYS use numeric digits (1, 2, 3) instead of words (one, two, three) for numeric answers

Return ONLY a valid JSON array with this exact structure (no markdown, no explanations):
[
  {
    "id": "q1",
    "question": "Specific question based on the documentation...",
    "answer": "short specific answer",
    "hints": ["subtle hint", "moderate hint", "almost gives it away"],
    "category": "${file.name}",
    "source": "Section or page reference"
  }
]

**ZERO-GUESSING PROTOCOL - CRITICAL:**
- **DOCUMENTATION ONLY**: Every single fact MUST come DIRECTLY from the documentation above
- **EXPLICIT ONLY**: If not explicitly written in the documentation, DO NOT create a question about it
- **WORD-FOR-WORD VERIFICATION**: Locate the exact sentence containing the answer before finalizing
- If documentation is too sparse for ${numQuestions} questions, respond with "INSUFFICIENT_DOCUMENTATION: [explanation]"

Generate exactly ${numQuestions} questions that demonstrate deep understanding of this documentation.`;

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

    // Check for insufficient documentation
    if (aiResponse.includes('INSUFFICIENT_DOCUMENTATION')) {
      throw new Error('AI cannot generate quiz from this file. The content may be too sparse. AI stated: ' + aiResponse.substring(0, 200));
    }

    // Extract JSON
    const markdownMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      aiResponse = markdownMatch[1];
    }

    aiResponse = aiResponse.trim();
    if (!aiResponse.startsWith('[')) {
      const arrayStart = aiResponse.indexOf('[');
      if (arrayStart !== -1) {
        aiResponse = aiResponse.substring(arrayStart);
      }
    }

    const arrayEnd = aiResponse.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd < aiResponse.length - 1) {
      aiResponse = aiResponse.substring(0, arrayEnd + 1);
    }

    const questions = JSON.parse(aiResponse);

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('AI did not return a valid question array');
    }

    // Validate and clean questions
    const validQuestions = questions.filter(q =>
      q.question && q.answer && Array.isArray(q.hints) && q.hints.length >= 3
    ).map((q, index) => ({
      id: q.id || `file-${index + 1}`,
      question: q.question,
      answer: q.answer,
      hints: q.hints.slice(0, 3),
      category: q.category || file.name,
      source: q.source || file.name
    }));

    console.log('[AI Quiz] Generated', validQuestions.length, 'questions from file');
    return validQuestions;

  } catch (error) {
    console.error('[AI Quiz] File generation failed:', error);
    throw error;
  }
}
