# API Specification - PFE Platform

## Student API
- `POST /api/student/login`: Register or login a student.
- `POST /api/student/submit`: Submit a GitHub repository for evaluation.
- `GET /api/student/grade/:studentId`: Retrieve approved grades for a student.

## Teacher API
- `POST /api/teacher/login`: Login as a teacher.
- `GET /api/teacher/submissions`: List all submissions pending review.
- `POST /api/teacher/approve`: Approve a submission grade and publish it.
