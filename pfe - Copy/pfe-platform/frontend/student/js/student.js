document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const submitRepoForm = document.getElementById('submit-repo-form');
    const loginSection = document.getElementById('login-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const studentNameDisplay = document.getElementById('student-name-display');
    const logoutBtn = document.getElementById('logout-btn');
    const gradesList = document.getElementById('grades-list');
    const submissionStatus = document.getElementById('submission-status');
    const submitTeacherSelect = document.getElementById('submit-teacher');

    let currentStudent = JSON.parse(localStorage.getItem('student'));
    if (currentStudent) showDashboard();

    async function fetchTeachersForStudent() {
        if (!submitTeacherSelect) return;
        submitTeacherSelect.innerHTML = '<option value="">Select your teacher</option>';
        try {
            const response = await fetch('/api/teacher/list');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const teachers = await response.json();
            if (Array.isArray(teachers) && teachers.length > 0) {
                teachers.forEach(({ id, name }) => {
                    const option = document.createElement('option');
                    option.value = id;
                    option.textContent = name;
                    submitTeacherSelect.appendChild(option);
                });
                return;
            }
            ['tarek1', 'tarek2', 'tarek3', 'tarek4', 'tarek5', 'tarek6'].forEach((name) => {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = `${name} (available after server restart)`;
                option.disabled = true;
                submitTeacherSelect.appendChild(option);
            });
        } catch {
            submitTeacherSelect.innerHTML = '<option value="">Failed to load teachers</option>';
        }
    }

    fetchTeachersForStudent();

    // Student Login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = { name: document.getElementById('login-name').value, student_id: document.getElementById('login-student-id').value };
        if (!String(data.student_id || '').trim()) {
            alert('Please enter your student ID.');
            return;
        }

        try {
            const response = await fetch('/api/student/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Student login failed');
            }
            currentStudent = payload;
            localStorage.setItem('student', JSON.stringify(currentStudent));
            showDashboard();
        } catch (error) {
            if (String(error.message || '').includes('Teacher selection is required')) {
                alert('Login is using an old backend version. Restart backend and refresh browser (Ctrl+F5), then try again.');
            } else {
                alert('Login failed: ' + error.message);
            }
        }
    });

    submitRepoForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const repoUrl = document.getElementById('repo-url').value;
        
        submissionStatus.className = 'mt-4 p-3 rounded-md bg-blue-100 text-blue-700';
        submissionStatus.textContent = 'Submitting...';
        submissionStatus.classList.remove('hidden');

        try {
            const teacherId = Number.parseInt(submitTeacherSelect.value, 10);
            const groupName = String(document.getElementById('submit-group').value || '').trim();
            const year = String(document.getElementById('submit-year').value || '').trim().toUpperCase();
            if (Number.isNaN(teacherId)) throw new Error('Please select your teacher');
            if (!groupName) throw new Error('Please enter your group');
            if (!year) throw new Error('Please select your year/level');

            const response = await fetch('/api/student/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ studentId: currentStudent.id, repoUrl, teacherId, group_name: groupName, year })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'Submission failed');
            }
            
            submissionStatus.className = 'mt-4 p-3 rounded-md bg-green-100 text-green-700';
            submissionStatus.textContent = result.message;
            
            document.getElementById('repo-url').value = '';
        } catch (error) {
            submissionStatus.className = 'mt-4 p-3 rounded-md bg-red-100 text-red-700';
            submissionStatus.textContent = 'Submission failed: ' + error.message;
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('student');
        window.location.href = '/index.html';
    });

    function showDashboard() {
        loginSection.classList.add('hidden');
        dashboardSection.classList.remove('hidden');
        studentNameDisplay.textContent = currentStudent.name;
        fetchGrades();
    }

    const pendingCard = `
        <div class="border p-4 rounded-md bg-blue-50 mb-4">
            <p class="font-semibold text-blue-800">Grading in process</p>
        </div>
    `;

    async function fetchGrades() {
        try {
            const allResponse = await fetch(`/api/student/submissions/${currentStudent.id}`);
            const allSubmissions = await allResponse.json();
            if (allSubmissions.length === 0) {
                gradesList.innerHTML = '<p class="text-gray-500 italic">No submissions yet.</p>';
                return;
            }
            gradesList.innerHTML = allSubmissions.map((s) => s.status === 'approved'
                ? `<div class="border p-4 rounded-md bg-green-50 mb-4">
                    <p class="font-bold text-green-800 mb-2">Final Grade: ${s.grade}/20</p>
                    <div class="bg-white p-3 rounded border text-sm mt-2">
                        <p class="font-semibold mb-1">Teacher Feedback:</p>
                        <p>${s.teacher_feedback || 'No feedback provided.'}</p>
                    </div>
                </div>`
                : pendingCard).join('');
        } catch (error) {
            console.error('Error fetching grades:', error);
        }
    }

    // Refresh grades every 30 seconds
    setInterval(() => {
        if (currentStudent) fetchGrades();
    }, 30000);
});
