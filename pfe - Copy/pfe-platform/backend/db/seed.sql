-- Seed data for PFE Platform

-- Add a Teacher (password: password123)
INSERT INTO teachers (name, email, password) VALUES ('Dr. Smith', 'smith@university.edu', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi');

-- Add some Students (passwords: pass123)
INSERT INTO students (name, email, group_name, year, password, teacher_id) VALUES
('Alice Johnson', 'alice@student.edu', 'G1', 'L3', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 1),
('Bob Wilson', 'bob@student.edu', 'G1', 'L3', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 1),
('Charlie Brown', 'charlie@student.edu', 'G2', 'M1', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 1);

-- Add Grading Criteria for G1 L3
INSERT INTO grading_criteria (group_name, year, criteria_json, teacher_id) VALUES
('G1', 'L3', '{"barem": "10 points for functionality, 5 points for clean code, 5 points for documentation."}', 1);

-- Add a sample submission
INSERT INTO submissions (student_id, repo_url, status, grade, ai_feedback) VALUES
(1, 'https://github.com/alice/pfe-project', 'completed', 16.5, 'Excellent structure and all tests passed.');
