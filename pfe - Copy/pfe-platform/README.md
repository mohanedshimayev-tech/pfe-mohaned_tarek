# PFE Platform: Intelligent Agent-Based GitHub Evaluation

An automated platform for instructors to retrieve, test, grade, and provide feedback on student assignments hosted on GitHub.

## Features
- **Multi-Agent Workflow**: Automated retrieval, testing, grading, and feedback generation.
- **Student Portal**: Submit GitHub repos and track grades.
- **Teacher Dashboard**: Define grading criteria, review AI evaluations, and publish results.
- **Group Management**: Students are grouped by class and year for streamlined evaluation.

## Tech Stack
- **Backend**: Node.js (Express), SQLite
- **Agents**: Custom JavaScript-based agents for workflow automation
- **Frontend**: HTML5, Tailwind CSS, JavaScript

## Getting Started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Access the portals:
   - Student: `http://localhost:3000/student/index.html`
   - Teacher: `http://localhost:3000/teacher/index.html`

## Agents Architecture
- **RepoRetriever**: Uses GitHub API to fetch repository structure.
- **TestExecutor**: Simulates test suite execution and quality checks.
- **Grader**: Applies instructor-defined weights (Barem) to calculate scores.
- **FeedbackGenerator**: Produces detailed summaries and recommendations.
- **WorkflowManager**: Orchestrates the sequential execution of agents.
