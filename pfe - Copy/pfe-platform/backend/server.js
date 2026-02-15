const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
let bcrypt = null;
try {
    bcrypt = require('bcrypt');
} catch (error) {
    console.warn('bcrypt not available; using fallback teacher login.');
}

const app = express();

const envCandidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(process.cwd(), '.env')
];

function shouldReplaceEnvValue(value) {
    if (typeof value !== 'string') return true;
    const normalized = value.trim();
    if (!normalized) return true;
    const placeholderValues = new Set([
        'changeme',
        'replace_me',
        'none',
        'null',
        'undefined'
    ]);
    return placeholderValues.has(normalized.toLowerCase());
}

for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
        const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
        for (const [key, value] of Object.entries(parsed)) {
            const currentValue = process.env[key];
            if (shouldReplaceEnvValue(currentValue)) {
                process.env[key] = value;
            }
        }
        break;
    }
}

const PORT = process.env.PORT || 3000;
const { gradeStudentCode, getAiHealthStatus } = require('./services/aiService');
const repoRetriever = require('./core/agents/repoRetriever');

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function runCallback(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function parseCriteria(criteriaRow) {
    if (!criteriaRow || !criteriaRow.criteria_json) return {};
    try {
        const parsed = JSON.parse(criteriaRow.criteria_json);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

function stringifyCriteriaForPrompt(criteriaObject) {
    if (!criteriaObject || typeof criteriaObject !== 'object') return '';
    const barem = String(criteriaObject.barem || '').trim();
    const expectedOutput = String(criteriaObject.expectedOutput || '').trim();
    const notes = String(criteriaObject.notes || '').trim();
    const rubric = criteriaObject.rubric && typeof criteriaObject.rubric === 'object'
        ? JSON.stringify(criteriaObject.rubric, null, 2)
        : '';

    return [
        barem ? `Teacher barem:\n${barem}` : '',
        notes ? `Teacher notes:\n${notes}` : '',
        rubric ? `Rubric:\n${rubric}` : '',
        expectedOutput ? `Expected output:\n${expectedOutput}` : ''
    ].filter(Boolean).join('\n\n');
}

function buildTeacherFeedbackText(gradeResult) {
    const errors = Array.isArray(gradeResult.errors) ? gradeResult.errors : [];
    const improvements = Array.isArray(gradeResult.improvements) ? gradeResult.improvements : [];
    const feedback = String(gradeResult.feedback || '').trim() || 'No model feedback provided.';

    const errorLines = errors.length > 0
        ? errors.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
        : 'No concrete errors reported.';

    const improvementLines = improvements.length > 0
        ? improvements.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
        : 'No improvements suggested.';

    return [
        'Gemini Evaluation',
        '=================',
        '',
        `Grade: ${Number.parseFloat(gradeResult.grade || 0).toFixed(2)}/20`,
        '',
        'Feedback:',
        feedback,
        '',
        'Detected Errors:',
        errorLines,
        '',
        'Suggested Improvements:',
        improvementLines
    ].join('\n');
}

function normalizeCodeForFingerprint(source) {
    const raw = String(source || '');
    if (!raw.trim()) return '';

    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const withoutLineComments = withoutBlockComments
        .replace(/\/\/[^\n\r]*/g, ' ')
        .replace(/(^|[\n\r])\s*--[^\n\r]*/g, '$1 ')
        .replace(/<!--[\s\S]*?-->/g, ' ');

    return withoutLineComments
        .toLowerCase()
        .replace(/\s+/g, '');
}

function computeCodeFingerprint(source) {
    const normalized = normalizeCodeForFingerprint(source);
    if (!normalized || normalized.length < 20) return null;
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function findExactCodeDuplicate({
    submissionId,
    studentId,
    teacherId,
    groupName,
    year,
    codeFingerprint
}) {
    if (!codeFingerprint) return null;

    return dbGet(
        `SELECT s.id AS submission_id,
                st.id AS student_id,
                st.name AS student_name,
                st.student_code,
                s.submission_date
         FROM submissions s
         JOIN students st ON s.student_id = st.id
         WHERE s.id <> ?
           AND st.id <> ?
           AND COALESCE(s.teacher_id, st.teacher_id) = ?
           AND s.code_fingerprint = ?
         ORDER BY s.submission_date DESC, s.id DESC
         LIMIT 1`,
        [submissionId, studentId, teacherId, codeFingerprint]
    );
}

function buildDuplicateAlertText(duplicateMatch) {
    if (!duplicateMatch) return '';
    const studentCode = String(duplicateMatch.student_code || '').trim();
    const label = studentCode
        ? `${duplicateMatch.student_name} [ID: ${studentCode}]`
        : duplicateMatch.student_name;
    const submittedAt = duplicateMatch.submission_date
        ? new Date(duplicateMatch.submission_date).toISOString()
        : 'unknown date';

    return [
        'Potential Code Similarity Alert',
        '==============================',
        `Exact normalized-code match found with another student submission.`,
        `Matched submission: #${duplicateMatch.submission_id}`,
        `Matched student: ${label}`,
        `Matched submission date: ${submittedAt}`,
        'Similarity confidence: 100% (exact fingerprint match).'
    ].join('\n');
}

async function beginNewCorrectionGeneration(submissionId) {
    await dbRun(
        'UPDATE submissions SET correction_generation = COALESCE(correction_generation, 0) + 1 WHERE id = ?',
        [submissionId]
    );
    const row = await dbGet('SELECT correction_generation FROM submissions WHERE id = ?', [submissionId]);
    return Number.parseInt(row && row.correction_generation, 10) || 0;
}

async function processSubmissionWithGemini(submissionId, { expectedOutput = '', overrideBarem = '', expectedGeneration = null } = {}) {
    const submission = await dbGet(
        `SELECT s.*,
                COALESCE(s.teacher_id, st.teacher_id) AS teacher_id,
                st.group_name,
                st.year,
                COALESCE(s.correction_generation, 0) AS correction_generation
         FROM submissions s
         JOIN students st ON s.student_id = st.id
         WHERE s.id = ?`,
        [submissionId]
    );

    if (!submission) {
        throw new Error('Submission not found');
    }

    const activeGeneration = Number.isInteger(expectedGeneration)
        ? expectedGeneration
        : (Number.parseInt(submission.correction_generation, 10) || 0);
    const processingUpdate = await dbRun(
        'UPDATE submissions SET status = "processing" WHERE id = ? AND COALESCE(correction_generation, 0) = ?',
        [submissionId, activeGeneration]
    );
    if (!processingUpdate.changes) {
        return {
            status: 'canceled',
            grade: 0,
            ai_feedback: 'Correction canceled or replaced by a newer run.'
        };
    }

    const criteriaRow = await dbGet(
        'SELECT criteria_json FROM grading_criteria WHERE group_name = ? AND year = ?',
        [submission.group_name, submission.year]
    );
    const criteriaObject = parseCriteria(criteriaRow);
    const baremFromCriteria = String(criteriaObject.barem || '').trim();
    const finalBarem = String(overrideBarem || baremFromCriteria).trim();
    const criteriaText = stringifyCriteriaForPrompt({
        ...criteriaObject,
        barem: finalBarem || baremFromCriteria
    });
    const expected = String(expectedOutput || criteriaObject.expectedOutput || '').trim();

    if (!finalBarem) {
        const message = 'No teacher barem found for this submission group/year.';
        const failedUpdate = await dbRun(
            'UPDATE submissions SET status = "failed", ai_feedback = ? WHERE id = ? AND COALESCE(correction_generation, 0) = ?',
            [message, submissionId, activeGeneration]
        );
        if (!failedUpdate.changes) {
            return {
                status: 'canceled',
                grade: 0,
                ai_feedback: 'Correction canceled or replaced by a newer run.'
            };
        }
        return {
            status: 'failed',
            grade: 0,
            ai_feedback: message
        };
    }

    try {
        const repoInfo = await repoRetriever.getRepoInfo(submission.repo_url);
        const studentCode = Array.isArray(repoInfo.codeSnippets) && repoInfo.codeSnippets.length > 0
            ? repoInfo.codeSnippets
                .map((entry) => `FILE: ${entry.path}\n${entry.snippet}`)
                .join('\n\n--------------------\n\n')
            : 'No retrievable source snippets found in repository.';
        const codeFingerprint = computeCodeFingerprint(studentCode);
        const duplicateMatch = await findExactCodeDuplicate({
            submissionId,
            studentId: submission.student_id,
            teacherId: submission.teacher_id,
            groupName: submission.group_name,
            year: submission.year,
            codeFingerprint
        });
        const duplicateAlert = buildDuplicateAlertText(duplicateMatch);

        const gradeResult = await gradeStudentCode(studentCode, expected, criteriaText || finalBarem);
        const aiGrade = Number.isFinite(Number.parseFloat(gradeResult.grade))
            ? Math.max(0, Math.min(20, Number.parseFloat(gradeResult.grade)))
            : 0;
        const forcedZeroForDuplicate = Boolean(duplicateMatch);
        const grade = forcedZeroForDuplicate ? 0 : aiGrade;
        const duplicatePolicyNote = forcedZeroForDuplicate
            ? 'Duplicate policy applied: exact code match with another student submission. Final grade forced to 0/20.'
            : '';
        const aiFeedbackBase = buildTeacherFeedbackText({
            ...gradeResult,
            grade
        });
        const aiFeedback = [aiFeedbackBase, duplicatePolicyNote, duplicateAlert].filter(Boolean).join('\n\n');

        const completedUpdate = await dbRun(
            `UPDATE submissions
             SET status = "completed",
                 grade = ?,
                 ai_feedback = ?,
                 correction_instructions = ?,
                 code_fingerprint = ?,
                 duplicate_of_submission_id = ?,
                 duplicate_similarity = ?
             WHERE id = ?
               AND COALESCE(correction_generation, 0) = ?`,
            [
                grade,
                aiFeedback,
                finalBarem,
                codeFingerprint,
                duplicateMatch ? duplicateMatch.submission_id : null,
                duplicateMatch ? 1 : 0,
                submissionId,
                activeGeneration
            ]
        );
        if (!completedUpdate.changes) {
            return {
                status: 'canceled',
                grade: 0,
                ai_feedback: 'Correction canceled or replaced by a newer run.'
            };
        }

        // Flag the previously matched submission as similar too so both sides are visible in teacher UI.
        if (duplicateMatch && duplicateMatch.submission_id) {
            await dbRun(
                `UPDATE submissions
                 SET duplicate_similarity = CASE
                     WHEN duplicate_similarity IS NULL OR duplicate_similarity < 1 THEN 1
                     ELSE duplicate_similarity
                 END
                 WHERE id = ?`,
                [duplicateMatch.submission_id]
            );
        }

        return {
            status: 'completed',
            grade,
            ai_feedback: aiFeedback
        };
    } catch (error) {
        const message = `AI correction failed: ${error.message}`;
        const failedUpdate = await dbRun(
            `UPDATE submissions
             SET status = "failed",
                 ai_feedback = ?,
                 grade = 0
             WHERE id = ?
               AND COALESCE(correction_generation, 0) = ?`,
            [message, submissionId, activeGeneration]
        );
        if (!failedUpdate.changes) {
            return {
                status: 'canceled',
                grade: 0,
                ai_feedback: 'Correction canceled or replaced by a newer run.'
            };
        }
        return {
            status: 'failed',
            grade: 0,
            ai_feedback: message
        };
    }
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// Database setup
const dbDir = path.join(__dirname, './db');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(path.join(dbDir, 'platform.db'), (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to SQLite database.');
});

const TEACHER_SHARED_PASSWORD = 'admin';
const DEFAULT_TEACHERS = ['tarek1', 'tarek2', 'tarek3', 'tarek4', 'tarek5', 'tarek6'];

function hashPassword(password) {
    if (bcrypt) {
        return bcrypt.hashSync(password, 10);
    }
    return password;
}

async function isValidStoredPassword(plainPassword, storedPassword) {
    if (bcrypt && typeof storedPassword === 'string' && storedPassword.startsWith('$2')) {
        return bcrypt.compare(plainPassword, storedPassword);
    }
    return plainPassword === storedPassword;
}

function randomTeacherUsername() {
    const token = Math.random().toString(36).slice(2, 8);
    return `teacher_${token}`;
}

function generateUniqueTeacherUsername() {
    return new Promise((resolve, reject) => {
        const maxAttempts = 10;
        const tryGenerate = (attempt) => {
            if (attempt >= maxAttempts) {
                return reject(new Error('Failed to generate unique username'));
            }

            const candidate = randomTeacherUsername();
            db.get('SELECT id FROM teachers WHERE email = ?', [candidate], (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve(candidate);
                tryGenerate(attempt + 1);
            });
        };

        tryGenerate(0);
    });
}

function ensureStudentsTeacherColumn() {
    db.all('PRAGMA table_info(students)', (err, columns) => {
        if (err) {
            console.error('Failed to inspect students table:', err.message);
            return;
        }

        const hasTeacherId = columns.some((column) => column.name === 'teacher_id');
        if (hasTeacherId) return;

        db.run('ALTER TABLE students ADD COLUMN teacher_id INTEGER', (alterErr) => {
            if (alterErr) {
                console.error('Failed to add teacher_id column:', alterErr.message);
            } else {
                console.log('Added students.teacher_id column.');
            }
        });
    });
}

function ensureStudentsCodeColumn() {
    db.all('PRAGMA table_info(students)', (err, columns) => {
        if (err) {
            console.error('Failed to inspect students table:', err.message);
            return;
        }

        const hasStudentCode = columns.some((column) => column.name === 'student_code');
        if (!hasStudentCode) {
            db.run('ALTER TABLE students ADD COLUMN student_code TEXT', (alterErr) => {
                if (alterErr) {
                    console.error('Failed to add student_code column:', alterErr.message);
                    return;
                }
                db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_code ON students(student_code)', (indexErr) => {
                    if (indexErr) {
                        console.error('Failed to create unique index for student_code:', indexErr.message);
                    } else {
                        console.log('Added students.student_code column and unique index.');
                    }
                });
            });
            return;
        }

        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_code ON students(student_code)', (indexErr) => {
            if (indexErr) {
                console.error('Failed to ensure student_code index:', indexErr.message);
            }
        });
    });
}

function ensureSubmissionsSimilarityColumns() {
    db.all('PRAGMA table_info(submissions)', (err, columns) => {
        if (err) {
            console.error('Failed to inspect submissions table:', err.message);
            return;
        }

        const hasFingerprint = columns.some((column) => column.name === 'code_fingerprint');
        const hasDuplicateOf = columns.some((column) => column.name === 'duplicate_of_submission_id');
        const hasDuplicateSimilarity = columns.some((column) => column.name === 'duplicate_similarity');
        const hasCorrectionGeneration = columns.some((column) => column.name === 'correction_generation');
        const hasTeacherId = columns.some((column) => column.name === 'teacher_id');
        const pendingColumns = [];

        if (!hasFingerprint) pendingColumns.push({ name: 'code_fingerprint', type: 'TEXT' });
        if (!hasDuplicateOf) pendingColumns.push({ name: 'duplicate_of_submission_id', type: 'INTEGER' });
        if (!hasDuplicateSimilarity) pendingColumns.push({ name: 'duplicate_similarity', type: 'REAL' });
        if (!hasCorrectionGeneration) pendingColumns.push({ name: 'correction_generation', type: 'INTEGER DEFAULT 0' });
        if (!hasTeacherId) pendingColumns.push({ name: 'teacher_id', type: 'INTEGER' });

        const ensureIndexesAndBackfill = () => {
            db.run('CREATE INDEX IF NOT EXISTS idx_submissions_code_fingerprint ON submissions(code_fingerprint)', (indexErr) => {
                if (indexErr) {
                    console.error('Failed to ensure code_fingerprint index:', indexErr.message);
                }
            });
            db.run('CREATE INDEX IF NOT EXISTS idx_submissions_teacher_id ON submissions(teacher_id)', (teacherIndexErr) => {
                if (teacherIndexErr) {
                    console.error('Failed to ensure submissions.teacher_id index:', teacherIndexErr.message);
                }
            });
            db.run(
                `UPDATE submissions
                 SET teacher_id = (
                     SELECT st.teacher_id
                     FROM students st
                     WHERE st.id = submissions.student_id
                 )
                 WHERE teacher_id IS NULL`,
                (backfillErr) => {
                    if (backfillErr) {
                        console.error('Failed to backfill submissions.teacher_id:', backfillErr.message);
                    }
                }
            );
        };

        if (pendingColumns.length === 0) {
            ensureIndexesAndBackfill();
            return;
        }

        const addNextColumn = (index) => {
            if (index >= pendingColumns.length) {
                ensureIndexesAndBackfill();
                return;
            }

            const col = pendingColumns[index];
            db.run(`ALTER TABLE submissions ADD COLUMN ${col.name} ${col.type}`, (alterErr) => {
                if (alterErr) {
                    console.error(`Failed to add submissions.${col.name} column:`, alterErr.message);
                    return;
                }
                addNextColumn(index + 1);
            });
        };

        addNextColumn(0);
    });
}

function ensureTeacherExistsByName(teacherName, done) {
    db.get('SELECT id FROM teachers WHERE LOWER(name) = LOWER(?)', [teacherName], (err, row) => {
        if (err) {
            console.error(`Failed checking teacher ${teacherName}:`, err.message);
            done();
            return;
        }

        if (row) {
            done();
            return;
        }

        generateUniqueTeacherUsername()
            .then((generatedUsername) => {
                db.run(
                    'INSERT INTO teachers (name, email, password) VALUES (?, ?, ?)',
                    [teacherName, generatedUsername, hashPassword(TEACHER_SHARED_PASSWORD)],
                    (insertErr) => {
                        if (insertErr) {
                            console.error(`Failed inserting teacher ${teacherName}:`, insertErr.message);
                        }
                        done();
                    }
                );
            })
            .catch((generationErr) => {
                console.error(`Failed generating username for ${teacherName}:`, generationErr.message);
                done();
            });
    });
}

function ensureDefaultTeachers(done = () => {}) {
    let index = 0;
    const next = () => {
        if (index >= DEFAULT_TEACHERS.length) {
            done();
            return;
        }
        const teacherName = DEFAULT_TEACHERS[index];
        index += 1;
        ensureTeacherExistsByName(teacherName, next);
    };
    next();
}

function cleanupLegacyStudentsWithoutId() {
    db.serialize(() => {
        db.run(
            `DELETE FROM submissions
             WHERE student_id IN (
                SELECT id FROM students
                WHERE student_code IS NULL OR TRIM(student_code) = ''
             )`,
            (submissionErr) => {
                if (submissionErr) {
                    console.error('Failed deleting legacy submissions without student ID:', submissionErr.message);
                    return;
                }

                db.run(
                    `DELETE FROM students
                     WHERE student_code IS NULL OR TRIM(student_code) = ''`,
                    function(studentErr) {
                        if (studentErr) {
                            console.error('Failed deleting legacy students without student ID:', studentErr.message);
                            return;
                        }
                        if (this.changes > 0) {
                            console.log(`Deleted ${this.changes} legacy student(s) without student ID.`);
                        }
                    }
                );
            }
        );
    });
}

// Initialize tables from schema.sql
const schema = fs.readFileSync(path.join(__dirname, './db/schema.sql'), 'utf8');
db.exec(schema, (err) => {
    if (err) console.error('Schema initialization error:', err.message);
    else {
        ensureStudentsTeacherColumn();
        ensureStudentsCodeColumn();
        ensureSubmissionsSimilarityColumns();
        cleanupLegacyStudentsWithoutId();
        const shouldBootstrapDefaultData = process.env.BOOTSTRAP_DEFAULT_DATA === 'true';
        if (shouldBootstrapDefaultData) {
            ensureDefaultTeachers();
            // Seed if students table is empty
            db.get('SELECT COUNT(*) as count FROM students', (seedCheckErr, row) => {
                if (seedCheckErr) {
                    console.error('Seed check error:', seedCheckErr.message);
                    return;
                }
                if (row && row.count === 0) {
                    const seed = fs.readFileSync(path.join(__dirname, './db/seed.sql'), 'utf8');
                    db.exec(seed, (seedErr) => {
                        if (seedErr) console.error('Seed error:', seedErr.message);
                        else console.log('Database seeded successfully.');
                    });
                }
            });
        }
    }
});

// --- API Routes ---

// Backend AI grading endpoint (provider-agnostic service layer)
app.post('/api/ai/grade', async (req, res) => {
    try {
        const studentCode = String(req.body.studentCode || '').trim();
        const expectedOutput = String(req.body.expectedOutput || '').trim();
        const gradingCriteria = String(req.body.gradingCriteria || '').trim();

        if (!studentCode) {
            return res.status(400).json({ error: 'studentCode is required' });
        }

        const result = await gradeStudentCode(studentCode, expectedOutput, gradingCriteria);
        res.json(result);
    } catch (error) {
        console.error('AI grade endpoint failed:', error.message);
        res.status(500).json({
            grade: 0,
            errors: ['AI_UNAVAILABLE: endpoint_failure'],
            feedback: 'Automated grading failed. Please try again later.',
            improvements: []
        });
    }
});

// Backend AI health endpoint (does not expose secrets)
app.get('/api/ai/health', (req, res) => {
    try {
        res.json(getAiHealthStatus());
    } catch (error) {
        res.status(500).json({
            provider: 'gemini',
            configured: false,
            keyPresent: false,
            error: 'ai_health_failed'
        });
    }
});

// Teacher: set/update barem for a group + year
app.post('/api/teacher/criteria', (req, res) => {
    const teacherId = Number.parseInt(req.body.teacherId, 10);
    const groupName = String(req.body.group_name || '').trim();
    const year = String(req.body.year || '').trim().toUpperCase();
    const barem = String(req.body.barem || '').trim();
    const expectedOutput = String(req.body.expectedOutput || '').trim();
    const notes = String(req.body.notes || '').trim();

    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (!groupName) {
        return res.status(400).json({ error: 'group_name is required' });
    }
    if (!year) {
        return res.status(400).json({ error: 'year is required' });
    }
    if (!barem) {
        return res.status(400).json({ error: 'barem is required' });
    }

    const criteriaJson = JSON.stringify({
        barem,
        expectedOutput,
        notes
    });

    db.run(
        'INSERT OR REPLACE INTO grading_criteria (group_name, year, criteria_json, teacher_id) VALUES (?, ?, ?, ?)',
        [groupName, year, criteriaJson, teacherId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json({ message: 'Barem saved successfully.' });
        }
    );
});

app.get('/api/teacher/criteria/:group/:year', (req, res) => {
    const group = String(req.params.group || '').trim();
    const year = String(req.params.year || '').trim().toUpperCase();
    db.get(
        'SELECT criteria_json FROM grading_criteria WHERE group_name = ? AND year = ?',
        [group, year],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const parsed = parseCriteria(row);
            return res.json({
                barem: String(parsed.barem || ''),
                expectedOutput: String(parsed.expectedOutput || ''),
                notes: String(parsed.notes || '')
            });
        }
    );
});

// Teacher: trigger AI correction using stored barem for the submission's group/year.
app.post('/api/teacher/start-correction', async (req, res) => {
    const submissionId = Number.parseInt(req.body.submissionId, 10);
    const teacherId = Number.parseInt(req.body.teacherId, 10);
    const expectedOutput = String(req.body.expectedOutput || '').trim();
    const baremOverride = String(req.body.barem || req.body.instructions || '').trim();

    if (Number.isNaN(submissionId)) {
        return res.status(400).json({ error: 'Invalid submission id' });
    }
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (!baremOverride) {
        return res.status(400).json({ error: 'Teacher correction instructions are required' });
    }

    try {
        const ownerRow = await dbGet(
            `SELECT COALESCE(s.teacher_id, st.teacher_id) AS teacher_id
             FROM submissions s
             JOIN students st ON s.student_id = st.id
             WHERE s.id = ?`,
            [submissionId]
        );

        if (!ownerRow) {
            return res.status(404).json({ error: 'Submission not found' });
        }
        if (ownerRow.teacher_id !== teacherId) {
            return res.status(403).json({ error: 'You are not allowed to correct this submission' });
        }

        const expectedGeneration = await beginNewCorrectionGeneration(submissionId);
        const result = await processSubmissionWithGemini(submissionId, {
            expectedOutput,
            overrideBarem: baremOverride,
            expectedGeneration
        });
        return res.json(result);
    } catch (error) {
        return res.status(500).json({
            status: 'failed',
            grade: 0,
            ai_feedback: `Failed to run correction: ${error.message}`
        });
    }
});

async function handleCancelCorrectionsSelected(req, res) {
    const teacherId = Number.parseInt(req.body.teacherId, 10);
    const rawIds = Array.isArray(req.body.submissionIds) ? req.body.submissionIds : [];
    const submissionIds = Array.from(new Set(rawIds
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0)));

    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (submissionIds.length === 0) {
        return res.status(400).json({ error: 'At least one submission id is required' });
    }

    const placeholders = submissionIds.map(() => '?').join(', ');
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT s.id, s.status
                 FROM submissions s
                 JOIN students st ON s.student_id = st.id
                 WHERE COALESCE(s.teacher_id, st.teacher_id) = ?
                   AND s.id IN (${placeholders})`,
                [teacherId, ...submissionIds],
                (err, resultRows) => {
                    if (err) reject(err);
                    else resolve(resultRows || []);
                }
            );
        });

        if (rows.length === 0) {
            return res.json({
                message: 'No matching submissions found for selected ids.',
                canceled: 0,
                skippedApproved: 0
            });
        }

        let canceled = 0;
        let skippedApproved = 0;

        for (const row of rows) {
            if (String(row.status || '').toLowerCase() === 'approved') {
                skippedApproved += 1;
                continue;
            }

            await dbRun(
                `UPDATE submissions
                 SET status = "submitted",
                     grade = NULL,
                     ai_feedback = "Correction canceled by teacher. Ready for new correction.",
                     teacher_feedback = NULL,
                     correction_instructions = NULL,
                     code_fingerprint = NULL,
                     duplicate_of_submission_id = NULL,
                     duplicate_similarity = NULL,
                     correction_generation = COALESCE(correction_generation, 0) + 1
                 WHERE id = ?`,
                [row.id]
            );
            canceled += 1;
        }

        return res.json({
            message: `Canceled correction for ${canceled} selected submission(s).`,
            canceled,
            skippedApproved
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

// Teacher: cancel current correction state for selected submissions
app.post('/api/teacher/cancel-corrections-selected', handleCancelCorrectionsSelected);

// Backward-compatible alias for clients using alternative route naming
app.post('/api/teacher/cancel-selected-corrections', handleCancelCorrectionsSelected);

// Teacher: start a new correction run for selected submissions with one shared barem
app.post('/api/teacher/start-correction-selected', async (req, res) => {
    const teacherId = Number.parseInt(req.body.teacherId, 10);
    const instructions = String(req.body.instructions || req.body.barem || '').trim();
    const expectedOutput = String(req.body.expectedOutput || '').trim();
    const rawIds = Array.isArray(req.body.submissionIds) ? req.body.submissionIds : [];
    const submissionIds = Array.from(new Set(rawIds
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0)));

    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (!instructions) {
        return res.status(400).json({ error: 'Teacher correction instructions are required' });
    }
    if (submissionIds.length === 0) {
        return res.status(400).json({ error: 'At least one submission id is required' });
    }

    const placeholders = submissionIds.map(() => '?').join(', ');
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT s.id, s.status
                 FROM submissions s
                 JOIN students st ON s.student_id = st.id
                 WHERE COALESCE(s.teacher_id, st.teacher_id) = ?
                   AND s.id IN (${placeholders})`,
                [teacherId, ...submissionIds],
                (err, resultRows) => {
                    if (err) reject(err);
                    else resolve(resultRows || []);
                }
            );
        });

        if (rows.length === 0) {
            return res.json({
                message: 'No matching submissions found for selected ids.',
                processed: 0,
                completed: 0,
                failed: 0,
                canceled: 0,
                skippedApproved: 0
            });
        }

        let completed = 0;
        let failed = 0;
        let canceled = 0;
        let skippedApproved = 0;

        for (const row of rows) {
            if (String(row.status || '').toLowerCase() === 'approved') {
                skippedApproved += 1;
                continue;
            }

            const expectedGeneration = await beginNewCorrectionGeneration(row.id);
            const result = await processSubmissionWithGemini(row.id, {
                expectedOutput,
                overrideBarem: instructions,
                expectedGeneration
            });

            if (result.status === 'completed') completed += 1;
            else if (result.status === 'failed') failed += 1;
            else canceled += 1;
        }

        const processed = completed + failed + canceled;
        return res.json({
            message: `New correction run finished for selected submissions. Completed: ${completed}, failed: ${failed}, canceled: ${canceled}.`,
            processed,
            completed,
            failed,
            canceled,
            skippedApproved
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// Student Login/Register (Simplified)
app.post('/api/student/login', (req, res) => {
    const name = String(req.body.name || '').trim();
    const studentCode = String(req.body.student_id || '').trim();
    const normalizedName = name.toLowerCase();
    if (!name) {
        return res.status(400).json({ error: 'Full name is required' });
    }
    if (!studentCode) {
        return res.status(400).json({ error: 'Student ID is required' });
    }

    const generatedEmail = `student_${studentCode.toLowerCase()}@local.platform`;
    db.all(
        `SELECT *
         FROM students
         WHERE LOWER(TRIM(COALESCE(student_code, ''))) = LOWER(?)
            OR LOWER(COALESCE(email, '')) = LOWER(?)`,
        [studentCode, generatedEmail],
        (idErr, idMatches = []) => {
            if (idErr) return res.status(500).json({ error: idErr.message });

            if (idMatches.length > 0) {
                const exactNameMatch = idMatches.find((row) => String(row.name || '').trim().toLowerCase() === normalizedName);
                if (!exactNameMatch) {
                    return res.status(409).json({ error: 'Student ID already exists and belongs to another student.' });
                }

                return res.json({
                    id: exactNameMatch.id,
                    name: exactNameMatch.name,
                    student_code: exactNameMatch.student_code
                });
            }

            db.get(
                `SELECT id, name, student_code
                 FROM students
                 WHERE LOWER(TRIM(COALESCE(name, ''))) = LOWER(?)
                   AND LOWER(TRIM(COALESCE(student_code, ''))) <> LOWER(?)`,
                [name, studentCode],
                (nameErr, studentByName) => {
                    if (nameErr) return res.status(500).json({ error: nameErr.message });

                    if (studentByName) {
                        return res.status(409).json({ error: 'Student name already exists and belongs to another student ID.' });
                    }

                    db.run(
                        'INSERT INTO students (name, email, group_name, year, password, teacher_id, student_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [name, generatedEmail, 'UNASSIGNED', 'UNASSIGNED', 'password', null, studentCode],
                        function(insertErr) {
                            if (insertErr) {
                                if (String(insertErr.message || '').toLowerCase().includes('unique')) {
                                    return res.status(409).json({ error: 'Student ID already exists and belongs to another student.' });
                                }
                                return res.status(500).json({ error: insertErr.message });
                            }
                            return res.json({
                                id: this.lastID,
                                name,
                                student_code: studentCode
                            });
                        }
                    );
                }
            );
        }
    );
});

// Submit Repository
app.post('/api/student/submit', (req, res) => {
    const { studentId, repoUrl, teacherId, group_name, year } = req.body;
    const parsedStudentId = Number.parseInt(studentId, 10);
    const parsedTeacherId = Number.parseInt(teacherId, 10);
    const normalizedGroup = String(group_name || '').trim();
    const normalizedYear = String(year || '').trim().toUpperCase();
    
    if (Number.isNaN(parsedStudentId)) {
        return res.status(400).json({ error: 'Invalid student id' });
    }
    if (!repoUrl || !repoUrl.includes('github.com')) {
        return res.status(400).json({ error: 'Invalid GitHub URL' });
    }
    if (Number.isNaN(parsedTeacherId)) {
        return res.status(400).json({ error: 'Teacher selection is required' });
    }
    if (!normalizedGroup) {
        return res.status(400).json({ error: 'Group is required' });
    }
    if (!normalizedYear) {
        return res.status(400).json({ error: 'Year/level is required' });
    }

    db.get('SELECT id FROM teachers WHERE id = ?', [parsedTeacherId], (teacherErr, teacher) => {
        if (teacherErr) return res.status(500).json({ error: teacherErr.message });
        if (!teacher) return res.status(400).json({ error: 'Selected teacher does not exist' });

        db.run(
            'UPDATE students SET teacher_id = ?, group_name = ?, year = ? WHERE id = ?',
            [parsedTeacherId, normalizedGroup, normalizedYear, parsedStudentId],
            function(updateErr) {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Student not found' });

                // New submissions stay in submitted state for manual teacher review.
                db.run(
                    'INSERT INTO submissions (student_id, teacher_id, repo_url, status) VALUES (?, ?, ?, ?)',
                    [parsedStudentId, parsedTeacherId, repoUrl, 'submitted'],
                    function(insertErr) {
                        if (insertErr) return res.status(500).json({ error: insertErr.message });
                        res.json({ message: 'Submission received. Waiting for teacher AI instructions.', submissionId: this.lastID });
                    }
                );
            }
        );
    });
});

// Get All Student Submissions
app.get('/api/student/submissions/:studentId', (req, res) => {
    db.all('SELECT * FROM submissions WHERE student_id = ? ORDER BY submission_date DESC', 
        [req.params.studentId], (err, submissions) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(submissions);
        });
});

// Get Approved Student Grade
app.get('/api/student/grade/:studentId', (req, res) => {
    db.all('SELECT * FROM submissions WHERE student_id = ? AND status = "approved"', 
        [req.params.studentId], (err, submissions) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(submissions);
        });
});

app.post('/api/teacher/verify-password', (req, res) => {
    const { password } = req.body;
    if ((password || '').trim() !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
    const { teacherName, password } = req.body;
    if ((teacherName || '').trim().toLowerCase() !== 'admin' || (password || '').trim() !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    res.json({ ok: true });
});

app.get('/api/admin/teachers', (req, res) => {
    const adminPassword = (req.headers['x-admin-password'] || '').toString().trim();
    if (adminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    db.all(
        'SELECT id, name, email FROM teachers WHERE LOWER(name) != "admin" ORDER BY LOWER(name) ASC',
        [],
        (err, teachers) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(teachers.map((t) => ({ id: t.id, name: t.name, username: t.email })));
        }
    );
});

app.delete('/api/admin/students', (req, res) => {
    const adminPassword = (req.headers['x-admin-password'] || '').toString().trim();
    if (adminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run('DELETE FROM submissions', function(submissionErr) {
            if (submissionErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: submissionErr.message });
            }

            const deletedSubmissions = this.changes || 0;
            db.run('DELETE FROM students', function(studentErr) {
                if (studentErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: studentErr.message });
                }

                const deletedStudents = this.changes || 0;
                db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: commitErr.message });
                    }

                    return res.json({
                        message: `Deleted ${deletedStudents} student(s) and ${deletedSubmissions} submission(s).`,
                        deletedStudents,
                        deletedSubmissions
                    });
                });
            });
        });
    });
});

app.post('/api/admin/teachers', async (req, res) => {
    const { adminPassword, name, password } = req.body;
    const normalizedAdminPassword = (adminPassword || '').trim();
    const normalizedName = (name || '').trim();
    const normalizedPassword = (password || '').trim();

    if (normalizedAdminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!normalizedName || normalizedName.toLowerCase() === 'admin') {
        return res.status(400).json({ error: 'Invalid teacher name' });
    }
    if (!normalizedPassword) {
        return res.status(400).json({ error: 'Teacher password is required' });
    }

    db.get('SELECT id FROM teachers WHERE LOWER(name) = LOWER(?)', [normalizedName], async (findErr, existing) => {
        if (findErr) return res.status(500).json({ error: 'Database error' });
        if (existing) return res.status(409).json({ error: 'Teacher already exists' });

        try {
            const generatedUsername = await generateUniqueTeacherUsername();
            db.run(
                'INSERT INTO teachers (name, email, password) VALUES (?, ?, ?)',
                [normalizedName, generatedUsername, hashPassword(normalizedPassword)],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ error: 'Database error' });
                    res.json({ id: this.lastID, name: normalizedName, username: generatedUsername });
                }
            );
        } catch (generationError) {
            res.status(500).json({ error: 'Unable to create teacher account' });
        }
    });
});

app.post('/api/admin/teachers/:id/reveal-password', (req, res) => {
    const { adminPassword } = req.body;
    const teacherId = Number.parseInt(req.params.id, 10);
    const normalizedAdminPassword = (adminPassword || '').trim();

    if (normalizedAdminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }

    db.get('SELECT id, name, password FROM teachers WHERE id = ?', [teacherId], (err, teacher) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
        if ((teacher.name || '').toLowerCase() === 'admin') {
            return res.status(403).json({ error: 'Admin password cannot be viewed here' });
        }

        const storedPassword = teacher.password || '';
        if (storedPassword.startsWith('$2')) {
            return res.status(409).json({ error: 'Password is hashed and cannot be viewed. Use reset instead.' });
        }

        res.json({ password: storedPassword });
    });
});

const handleAdminTeacherPasswordUpdate = (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);
    const { adminPassword, newPassword } = req.body;
    const normalizedAdminPassword = (adminPassword || '').trim();
    const normalizedNewPassword = (newPassword || '').trim();

    if (normalizedAdminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (!normalizedNewPassword) {
        return res.status(400).json({ error: 'New password is required' });
    }

    db.get('SELECT id, name FROM teachers WHERE id = ?', [teacherId], (findErr, teacher) => {
        if (findErr) return res.status(500).json({ error: 'Database error' });
        if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
        if ((teacher.name || '').toLowerCase() === 'admin') {
            return res.status(403).json({ error: 'Admin password cannot be changed here' });
        }

        db.run(
            'UPDATE teachers SET password = ? WHERE id = ?',
            [hashPassword(normalizedNewPassword), teacherId],
            (updateErr) => {
                if (updateErr) return res.status(500).json({ error: 'Database error' });
                res.json({ message: 'Teacher password updated successfully.' });
            }
        );
    });
};

app.put('/api/admin/teachers/:id/password', handleAdminTeacherPasswordUpdate);
app.post('/api/admin/teachers/:id/password', handleAdminTeacherPasswordUpdate);

app.delete('/api/admin/teachers/:id', (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);
    const adminPassword = (req.headers['x-admin-password'] || '').toString().trim();

    if (adminPassword !== TEACHER_SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }

    db.get('SELECT id, name FROM teachers WHERE id = ?', [teacherId], (findErr, teacher) => {
        if (findErr) return res.status(500).json({ error: 'Database error' });
        if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
        if ((teacher.name || '').toLowerCase() === 'admin') {
            return res.status(403).json({ error: 'Admin account cannot be deleted' });
        }

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            db.run('UPDATE students SET teacher_id = NULL WHERE teacher_id = ?', [teacherId], (updateErr) => {
                if (updateErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: updateErr.message });
                }

                db.run('UPDATE submissions SET teacher_id = NULL WHERE teacher_id = ?', [teacherId], (submissionUpdateErr) => {
                    if (submissionUpdateErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: submissionUpdateErr.message });
                    }

                    db.run('DELETE FROM teachers WHERE id = ?', [teacherId], function(deleteErr) {
                        if (deleteErr) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: deleteErr.message });
                        }

                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ error: commitErr.message });
                            }
                            res.json({ message: 'Teacher deleted successfully.' });
                        });
                    });
                });
            });
        });
    });
});

// Teacher Login with per-teacher password.
app.post('/api/teacher/login', async (req, res) => {
    const { teacherName, username, password } = req.body;

    try {
        const normalizedTeacherName = (teacherName || username || '').trim();
        const normalizedPassword = (password || '').trim();

        if (!normalizedTeacherName) {
            return res.status(400).json({ error: 'Teacher name is required' });
        }
        if (!normalizedPassword) {
            return res.status(400).json({ error: 'Password is required' });
        }

        return db.get('SELECT * FROM teachers WHERE LOWER(name) = LOWER(?)', [normalizedTeacherName], async (err, teacher) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (!teacher) return res.status(401).json({ error: 'Invalid credentials' });

            const isValid = await isValidStoredPassword(normalizedPassword, teacher.password);
            if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

            const { password: _, ...teacherData } = teacher;
            return res.json(teacherData);
        });
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/teacher/list', (req, res) => {
    db.all(
        'SELECT id, name, email FROM teachers ORDER BY LOWER(name) ASC',
        [],
        (err, teachers) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(
                teachers.map((teacher) => ({
                    id: teacher.id,
                    name: teacher.name
                })).filter((teacher) => teacher.name.toLowerCase() !== 'admin')
            );
        }
    );
});

// Delete Student (Teacher only)
app.delete('/api/teacher/students/:id', (req, res) => {
    const studentId = Number.parseInt(req.params.id, 10);

    if (Number.isNaN(studentId)) {
        return res.status(400).json({ error: 'Invalid student id' });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Delete student's submissions first (foreign key constraint)
        db.run('DELETE FROM submissions WHERE student_id = ?', [studentId], (submissionErr) => {
            if (submissionErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: submissionErr.message });
            }

            db.run('DELETE FROM students WHERE id = ?', [studentId], function(studentErr) {
                if (studentErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: studentErr.message });
                }

                if (this.changes === 0) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Student not found' });
                }

                db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: commitErr.message });
                    }

                    res.json({ message: 'Student and all related submissions deleted successfully.' });
                });
            });
        });
    });
});

// Get All Students (Teacher only)
app.get('/api/teacher/students', (req, res) => {
    const teacherId = Number.parseInt(req.query.teacherId, 10);
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }

    let query = `
        SELECT st.id, st.name, st.student_code, st.email, st.group_name, st.year, COUNT(s.id) as submissions_count
        FROM students st
        LEFT JOIN submissions s ON s.student_id = st.id
    `;
    const params = [teacherId];
    query += ` WHERE st.teacher_id = ?
               AND st.student_code IS NOT NULL
               AND TRIM(st.student_code) <> ''`;

    query += `
        GROUP BY st.id, st.name, st.student_code, st.email, st.group_name, st.year
        ORDER BY st.name ASC
    `;

    db.all(query, params, (err, students) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(students);
    });
});

// Get Submissions for Review (Teacher)
app.get('/api/teacher/submissions', (req, res) => {
    const teacherId = Number.parseInt(req.query.teacherId, 10);
    if (Number.isNaN(teacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    let query = `
        SELECT s.*, st.name as student_name, st.student_code, st.email as student_email, st.group_name, st.year 
        FROM submissions s 
        JOIN students st ON s.student_id = st.id
    `;
    const params = [teacherId];
    query += ` WHERE COALESCE(s.teacher_id, st.teacher_id) = ?
               AND st.student_code IS NOT NULL
               AND TRIM(st.student_code) <> ''
               AND s.status IN ('submitted', 'completed', 'processing', 'failed', 'approved')`;

    query += ' ORDER BY s.submission_date DESC';

    db.all(query, params, (err, submissions) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(submissions);
    });
});

// Teacher: Approve Grade
app.post('/api/teacher/approve', (req, res) => {
    const { submissionId, teacherFeedback, grade, teacherId } = req.body;
    const parsedSubmissionId = Number.parseInt(submissionId, 10);
    const parsedTeacherId = Number.parseInt(teacherId, 10);
    const parsedGrade = Number.parseFloat(grade);

    if (Number.isNaN(parsedSubmissionId)) {
        return res.status(400).json({ error: 'Invalid submission id' });
    }

    if (Number.isNaN(parsedTeacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }

    if (Number.isNaN(parsedGrade) || parsedGrade < 0 || parsedGrade > 20) {
        return res.status(400).json({ error: 'Grade must be between 0 and 20' });
    }

    db.get(
        'SELECT COALESCE(s.teacher_id, st.teacher_id) AS teacher_id, s.ai_feedback FROM submissions s JOIN students st ON s.student_id = st.id WHERE s.id = ?',
        [parsedSubmissionId],
        (findErr, row) => {
            if (findErr) return res.status(500).json({ error: findErr.message });
            if (!row) return res.status(404).json({ error: 'Submission not found' });
            if (row.teacher_id !== parsedTeacherId) {
                return res.status(403).json({ error: 'You are not allowed to approve this submission' });
            }

            const normalizedTeacherFeedback = String(teacherFeedback || '').trim();
            const finalTeacherFeedback = normalizedTeacherFeedback;

            db.run(
                'UPDATE submissions SET status = "approved", teacher_feedback = ?, grade = ? WHERE id = ?',
                [finalTeacherFeedback, parsedGrade, parsedSubmissionId],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Grade approved and visible to student.' });
                }
            );
        }
    );
});

function buildFilteredSubmissionQuery(parsedTeacherId, normalizedFilters = {}, statuses = ['submitted', 'completed']) {
    const groupFilter = String(normalizedFilters.group || '').trim();
    const yearFilter = String(normalizedFilters.year || '').trim();
    const studentNameFilter = String(normalizedFilters.studentName || '').trim();
    const placeholders = statuses.map(() => '?').join(', ');
    const params = [parsedTeacherId, ...statuses];
    let query = `
        SELECT s.id, s.grade, s.ai_feedback, s.teacher_feedback
        FROM submissions s
        JOIN students st ON s.student_id = st.id
        WHERE COALESCE(s.teacher_id, st.teacher_id) = ?
          AND s.status IN (${placeholders})
    `;

    if (groupFilter) {
        query += ' AND LOWER(st.group_name) = LOWER(?)';
        params.push(groupFilter);
    }

    if (yearFilter) {
        query += ' AND UPPER(st.year) = UPPER(?)';
        params.push(yearFilter);
    }

    if (studentNameFilter) {
        query += ' AND LOWER(st.name) LIKE LOWER(?)';
        params.push(`%${studentNameFilter}%`);
    }

    return { query, params };
}

// Teacher: Run AI correction on all filtered non-approved submissions with one shared barem
app.post('/api/teacher/start-correction-bulk', async (req, res) => {
    const { teacherId, instructions, filters } = req.body;
    const parsedTeacherId = Number.parseInt(teacherId, 10);
    const normalizedInstructions = String(instructions || '').trim();

    if (Number.isNaN(parsedTeacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }
    if (!normalizedInstructions) {
        return res.status(400).json({ error: 'Teacher correction instructions are required' });
    }

    const { query, params } = buildFilteredSubmissionQuery(
        parsedTeacherId,
        filters || {},
        ['submitted', 'completed', 'failed']
    );

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(query, params, (findErr, resultRows) => {
                if (findErr) reject(findErr);
                else resolve(resultRows || []);
            });
        });

        if (rows.length === 0) {
            return res.json({
                message: 'No non-approved submissions found for current filters.',
                processed: 0,
                completed: 0,
                failed: 0
            });
        }

        let completedCount = 0;
        let failedCount = 0;
        let canceledCount = 0;

        for (const row of rows) {
            try {
                const expectedGeneration = await beginNewCorrectionGeneration(row.id);
                const result = await processSubmissionWithGemini(row.id, {
                    overrideBarem: normalizedInstructions,
                    expectedGeneration
                });
                if (result.status === 'completed') completedCount += 1;
                else if (result.status === 'failed') failedCount += 1;
                else canceledCount += 1;
            } catch (error) {
                failedCount += 1;
            }
        }

        return res.json({
            message: `Bulk AI correction finished. Completed: ${completedCount}, failed: ${failedCount}, canceled: ${canceledCount}, total: ${rows.length}.`,
            processed: rows.length,
            completed: completedCount,
            failed: failedCount,
            canceled: canceledCount
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// Teacher: Approve all filtered pending submissions
app.post('/api/teacher/approve-bulk', (req, res) => {
    const { teacherId, teacherFeedback, grade, filters } = req.body;
    const parsedTeacherId = Number.parseInt(teacherId, 10);
    const normalizedTeacherFeedback = String(teacherFeedback || '').trim();

    if (Number.isNaN(parsedTeacherId)) {
        return res.status(400).json({ error: 'Invalid teacher id' });
    }

    let parsedGrade = null;
    if (grade !== undefined && grade !== null && String(grade).trim() !== '') {
        parsedGrade = Number.parseFloat(grade);
        if (Number.isNaN(parsedGrade) || parsedGrade < 0 || parsedGrade > 20) {
            return res.status(400).json({ error: 'Grade must be between 0 and 20 when provided' });
        }
    }

    const { query, params } = buildFilteredSubmissionQuery(parsedTeacherId, filters || {}, ['submitted', 'completed']);

    db.all(query, params, (findErr, rows) => {
        if (findErr) return res.status(500).json({ error: findErr.message });

        if (!rows || rows.length === 0) {
            return res.json({
                message: 'No pending submissions found for current filters.',
                approved: 0
            });
        }

        let approvedCount = 0;
        let pending = rows.length;
        let hasError = false;

        rows.forEach((row) => {
            const finalGrade = parsedGrade !== null
                ? parsedGrade
                : (Number.isFinite(Number.parseFloat(row.grade)) ? Number.parseFloat(row.grade) : 0);
            const finalTeacherFeedback = normalizedTeacherFeedback
                || String(row.teacher_feedback || '').trim()
                || String(row.ai_feedback || '').trim();

            db.run(
                'UPDATE submissions SET status = "approved", teacher_feedback = ?, grade = ? WHERE id = ?',
                [finalTeacherFeedback, finalGrade, row.id],
                (updateErr) => {
                    if (hasError) return;
                    if (updateErr) {
                        hasError = true;
                        return res.status(500).json({ error: updateErr.message });
                    }

                    approvedCount += 1;
                    pending -= 1;

                    if (pending === 0) {
                        return res.json({
                            message: `Approved ${approvedCount} submission(s) for current filters.`,
                            approved: approvedCount
                        });
                    }
                }
            );
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
