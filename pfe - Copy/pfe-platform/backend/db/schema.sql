-- Database Schema for PFE Platform

-- Students Table
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    group_name TEXT NOT NULL,
    year TEXT NOT NULL,
    password TEXT NOT NULL,
    teacher_id INTEGER,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);

-- Teachers Table
CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
);

-- Submissions Table
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    teacher_id INTEGER,
    repo_url TEXT NOT NULL,
    submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending', -- pending, waiting_instructions, processing, completed, approved
    grade REAL,
    ai_feedback TEXT,
    teacher_feedback TEXT,
    correction_instructions TEXT, -- New field for teacher's specific instructions to the AI
    code_fingerprint TEXT, -- Normalized code hash used for same-code detection across students
    duplicate_of_submission_id INTEGER, -- Points to matched submission id when duplicate is detected
    duplicate_similarity REAL, -- 1.0 for exact fingerprint match
    correction_generation INTEGER DEFAULT 0, -- Incremented to cancel/replace in-flight correction runs
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);

-- Grading Criteria (Barem) Table
CREATE TABLE IF NOT EXISTS grading_criteria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    year TEXT NOT NULL,
    criteria_json TEXT NOT NULL, -- JSON string containing the barem
    teacher_id INTEGER,
    UNIQUE(group_name, year),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);
