# Architecture Overview

## Backend AI Service
The platform uses a modular AI service layer:
1. **AI Route**: `POST /api/ai/grade` receives grading input.
2. **Service Module**: `backend/services/aiService.js` handles provider logic.
3. **Provider**: Google Gemini Flash via `@google/generative-ai`.
4. **Fallback**: Safe JSON response if provider fails.

## Tech Stack
- **Backend**: Node.js, Express, SQLite3.
- **Frontend**: Tailwind CSS, Vanilla JS (for simplicity and speed).
- **AI Provider**: Google Gemini (Flash model).
