const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_FLASH_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini';
const FALLBACK_FLASH_MODELS = [
    'gemini-2.5-flash',
    'gemini-flash-latest',
    'gemini-2.5-flash-lite'
];

function buildFallbackResponse(reason) {
    return {
        grade: 0,
        errors: [`AI_UNAVAILABLE: ${reason}`],
        feedback: 'Automated grading is temporarily unavailable. Please review manually.',
        improvements: ['Retry grading later or provide manual teacher feedback.']
    };
}

function normalizeArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function normalizeGrade(value) {
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(20, Number.parseFloat(numeric.toFixed(2))));
}

function sanitizeGeminiText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return '';
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
        return fenced[1].trim();
    }
    return text;
}

function parseGeminiJson(rawText) {
    const cleaned = sanitizeGeminiText(rawText);
    if (!cleaned) return null;

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            return null;
        }
        const candidate = cleaned.slice(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(candidate);
        } catch (secondError) {
            return null;
        }
    }
}

function normalizeModelResult(parsed, fallbackReason = 'invalid_model_response') {
    if (!parsed || typeof parsed !== 'object') {
        return buildFallbackResponse(fallbackReason);
    }

    return {
        grade: normalizeGrade(parsed.grade),
        errors: normalizeArray(parsed.errors),
        feedback: String(parsed.feedback || '').trim() || 'No feedback was generated.',
        improvements: normalizeArray(parsed.improvements)
    };
}

function buildPrompt(studentCode, expectedOutput, gradingCriteria) {
    return `
You are a strict programming evaluator.
Analyze the student code, compare behavior with expected output, and grade fairly.
Teacher grading instructions are the highest-priority rules and must be followed exactly.

Return ONLY valid JSON (no markdown, no extra text) using this schema:
{
  "grade": number,
  "errors": ["string"],
  "feedback": "string",
  "improvements": ["string"]
}

Rules:
- grade must be from 0 to 20.
- errors must list concrete defects/bugs if any.
- feedback must be concise and actionable.
- improvements must be specific next steps.
- Apply teacher grading criteria first when assigning the final grade.

Student code:
${String(studentCode || '').trim() || '(empty)'}

Expected output:
${String(expectedOutput || '').trim() || '(not provided)'}

Grading criteria:
${String(gradingCriteria || '').trim() || '(not provided)'}
`.trim();
}

function createGeminiModel() {
    const apiKey = String(process.env.GOOGLE_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('GOOGLE_API_KEY is missing.');
    }

    const client = new GoogleGenerativeAI(apiKey);
    return client;
}

async function generateWithModel(client, modelName, prompt) {
    const model = client.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            // Keep grading deterministic for identical code + criteria.
            temperature: 0,
            topP: 0.01,
            topK: 1,
            responseMimeType: 'application/json'
        }
    });

    const responseText = result && result.response ? result.response.text() : '';
    const parsed = parseGeminiJson(responseText);
    return normalizeModelResult(parsed);
}

function buildModelCandidates() {
    const ordered = [DEFAULT_FLASH_MODEL, ...FALLBACK_FLASH_MODELS];
    const deduped = [];
    const seen = new Set();
    for (const name of ordered) {
        const normalized = String(name || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(normalized);
    }
    return deduped;
}

function isModelNotFoundError(error) {
    const message = String(error && error.message ? error.message : '').toLowerCase();
    return message.includes('404') || message.includes('not found') || message.includes('models/');
}

async function gradeWithGemini(studentCode, expectedOutput, gradingCriteria) {
    const client = createGeminiModel();
    const prompt = buildPrompt(studentCode, expectedOutput, gradingCriteria);
    const modelCandidates = buildModelCandidates();
    let lastError = null;

    for (let i = 0; i < modelCandidates.length; i += 1) {
        const modelName = modelCandidates[i];
        try {
            return await generateWithModel(client, modelName, prompt);
        } catch (error) {
            lastError = error;
            if (isModelNotFoundError(error) && i < modelCandidates.length - 1) {
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('No Gemini model candidate succeeded.');
}

async function gradeStudentCode(studentCode, expectedOutput, gradingCriteria) {
    try {
        if (AI_PROVIDER !== 'gemini') {
            return buildFallbackResponse(`unsupported_provider:${AI_PROVIDER}`);
        }

        return await gradeWithGemini(studentCode, expectedOutput, gradingCriteria);
    } catch (error) {
        const message = error && error.message ? error.message : 'unexpected_ai_error';
        console.error('Gemini grading failed:', message);
        return buildFallbackResponse(message);
    }
}

function getAiHealthStatus() {
    const key = String(process.env.GOOGLE_API_KEY || '').trim();
    return {
        provider: AI_PROVIDER,
        model: DEFAULT_FLASH_MODEL,
        configured: Boolean(key),
        keyPresent: Boolean(key)
    };
}

module.exports = {
    gradeStudentCode,
    getAiHealthStatus
};
