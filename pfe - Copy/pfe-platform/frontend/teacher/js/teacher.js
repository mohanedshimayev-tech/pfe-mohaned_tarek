document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const loginSection = document.getElementById('login-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const logoutBtn = document.getElementById('logout-btn');
    const submissionsListUnapproved = document.getElementById('submissions-list-unapproved');
    const submissionsListApproved = document.getElementById('submissions-list-approved');
    const studentsList = document.getElementById('students-list');
    const loginTeacherName = document.getElementById('login-teacher-name');
    const loginPassword = document.getElementById('login-password');
    const filterGroup = document.getElementById('filter-group');
    const filterYear = document.getElementById('filter-year');
    const filterStudentName = document.getElementById('filter-student-name');
    const clearFiltersBtn = document.getElementById('clear-filters-btn');
    const bulkApproveFeedback = document.getElementById('bulk-approve-feedback');
    const bulkApproveGrade = document.getElementById('bulk-approve-grade');
    const approveBulkBtn = document.getElementById('approve-bulk-btn');
    const bulkCorrectionInstructions = document.getElementById('bulk-correction-instructions');
    const bulkCorrectionBtn = document.getElementById('bulk-correction-btn');
    const selectedSubmissionsCount = document.getElementById('selected-submissions-count');
    const selectFilteredBtn = document.getElementById('select-filtered-btn');
    const clearSelectionBtn = document.getElementById('clear-selection-btn');
    const cancelSelectedCorrectionsBtn = document.getElementById('cancel-selected-corrections-btn');
    const restartSelectedCorrectionsBtn = document.getElementById('restart-selected-corrections-btn');
    
    // Modal elements
    const reviewModal = document.getElementById('review-modal');
    const closeModal = document.getElementById('close-modal');
    const approveBtn = document.getElementById('approve-grade-btn');
    const startCorrectionSection = document.getElementById('start-correction-section');
    const correctionInstructions = document.getElementById('correction-instructions');
    const startAiBtn = document.getElementById('start-ai-btn');
    const modalStudentName = document.getElementById('modal-student-name');
    const modalRepoLink = document.getElementById('modal-repo-link');
    const modalAiFeedback = document.getElementById('modal-ai-feedback');
    const modalGrade = document.getElementById('modal-grade');
    const modalTeacherFeedback = document.getElementById('modal-teacher-feedback');

    let currentTeacher = null;
    let activeSubmissionId = null;
    let allSubmissions = [];
    let allStudents = [];
    const selectedSubmissionIds = new Set();
    const normalizeTeacherKey = (name) => (name || '').trim().toLowerCase();
    const statusColors = {
        submitted: 'bg-slate-100 text-slate-800',
        completed: 'bg-blue-100 text-blue-800',
        processing: 'bg-yellow-100 text-yellow-800',
        failed: 'bg-red-100 text-red-800',
        approved: 'bg-green-100 text-green-800'
    };

    function setReviewModalVisibility(isOpen) {
        const modalPanel = reviewModal ? reviewModal.querySelector('.review-modal-panel') : null;
        if (isOpen) {
            reviewModal.classList.remove('hidden');
            document.body.classList.add('modal-open');
            if (modalPanel) {
                modalPanel.scrollTop = 0;
            }
            reviewModal.scrollTop = 0;
        } else {
            reviewModal.classList.add('hidden');
            document.body.classList.remove('modal-open');
        }
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = (loginPassword ? loginPassword.value : '').trim();
        const teacherName = (loginTeacherName ? loginTeacherName.value : '').trim();

        if (!teacherName) {
            alert('Please enter your teacher name.');
            return;
        }

        if (!password) {
            alert('Please enter your password.');
            return;
        }

        if (teacherName.toLowerCase() === 'admin') {
            if (password === 'admin') {
                localStorage.setItem('admin_password', password);
                window.location.href = '/teacher/admin.html';
            } else {
                alert('Invalid admin credentials');
            }
            return;
        }

        const teacherKey = normalizeTeacherKey(teacherName);
        const teacherPasswordOverrides = JSON.parse(localStorage.getItem('teacher_password_overrides') || '{}');
        let overridePassword = teacherPasswordOverrides[teacherKey];
        if (!overridePassword) {
            const legacyKey = Object.keys(teacherPasswordOverrides).find((key) => normalizeTeacherKey(key) === teacherKey);
            if (legacyKey) {
                overridePassword = teacherPasswordOverrides[legacyKey];
                teacherPasswordOverrides[teacherKey] = overridePassword;
                if (legacyKey !== teacherKey) {
                    delete teacherPasswordOverrides[legacyKey];
                }
                localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
            }
        }
        if (overridePassword && password !== overridePassword) {
            alert('Invalid password. Please use the updated password set by admin.');
            return;
        }

        try {
            let response = await fetch('/api/teacher/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teacherName, password })
            });

            // Legacy-backend compatibility:
            // if custom local password exists and backend rejects, retry with shared admin password.
            if (!response.ok && overridePassword && overridePassword === password) {
                response = await fetch('/api/teacher/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ teacherName, password: 'admin' })
                });
            }

            const payload = await response.json();
            if (!response.ok) {
                alert(payload.error || 'Login failed');
                return;
            }

            currentTeacher = payload;
            localStorage.setItem('teacher', JSON.stringify(currentTeacher));
            showDashboard();
        } catch (error) {
            alert('Login failed');
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('teacher');
        window.location.href = '/index.html';
    });

    function getActiveFilters() {
        return {
            group: (filterGroup ? filterGroup.value : '').trim().toLowerCase(),
            year: (filterYear ? filterYear.value : '').trim().toUpperCase(),
            studentName: (filterStudentName ? filterStudentName.value : '').trim().toLowerCase()
        };
    }

    function buildFiltersPayload() {
        const { group, year, studentName } = getActiveFilters();
        return {
            group: group || '',
            year: year || '',
            studentName: studentName || ''
        };
    }

    function isSubmissionSelectable(submission) {
        return String(submission.status || '').toLowerCase() !== 'approved';
    }

    function syncSelectedSubmissionIdsWithData() {
        const validIds = new Set(allSubmissions.map((item) => Number.parseInt(item.id, 10)).filter((id) => Number.isInteger(id)));
        Array.from(selectedSubmissionIds).forEach((id) => {
            if (!validIds.has(id)) {
                selectedSubmissionIds.delete(id);
            }
        });
    }

    function updateSelectedCountLabel() {
        if (!selectedSubmissionsCount) return;
        selectedSubmissionsCount.textContent = `Selected: ${selectedSubmissionIds.size}`;
    }

    function getSelectedSubmissionIds() {
        return Array.from(selectedSubmissionIds);
    }

    function applyStudentFilters(items) {
        const { group, year, studentName } = getActiveFilters();
        return items.filter((item) => {
            const matchesGroup = !group || String(item.group_name || '').toLowerCase() === group;
            const matchesYear = !year || String(item.year || '').toUpperCase() === year;
            const matchesName = !studentName || String(item.student_name || item.name || '').toLowerCase().includes(studentName);
            return matchesGroup && matchesYear && matchesName;
        });
    }

    function resolveStudentCode(item) {
        const direct = String(item.student_code || '').trim();
        if (direct) return direct;

        const email = String(item.student_email || item.email || '').trim().toLowerCase();
        const localEmailMatch = email.match(/^student_(.+)@local\.platform$/);
        if (localEmailMatch && localEmailMatch[1]) return localEmailMatch[1];

        return 'N/A';
    }

    function formatStudentLabel(name, item) {
        return `${name} [ID: ${resolveStudentCode(item)}]`;
    }

    function hasSimilarityFlag(submission) {
        const similarity = Number.parseFloat(submission && submission.duplicate_similarity);
        if (Number.isFinite(similarity) && similarity >= 1) return true;
        if (submission && submission.duplicate_of_submission_id) return true;

        const feedback = String(submission && submission.ai_feedback || '').toLowerCase();
        return feedback.includes('potential code similarity alert')
            || feedback.includes('duplicate policy applied');
    }

    async function handleDeleteStudent(studentId, refreshStudents = false) {
        if (!confirm('Are you sure you want to delete this student and all their submissions? This action cannot be undone.')) return;
        try {
            const deleted = await deleteStudent(studentId);
            if (!deleted) return;
            fetchSubmissions();
            if (studentsList && refreshStudents) fetchStudents();
        } catch (error) {
            alert(error.message || 'Failed to delete student');
        }
    }

    async function startCorrectionForSubmission(submissionId, seedInstructions = '') {
        const instructions = prompt('Enter AI correction instructions (barem):', seedInstructions || '');
        if (instructions === null) return;
        const normalized = String(instructions || '').trim();
        if (!normalized) {
            alert('Instructions are required.');
            return;
        }

        try {
            const response = await fetch('/api/teacher/start-correction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    submissionId,
                    teacherId: currentTeacher.id,
                    instructions: normalized
                })
            });
            const result = await response.json();
            if (!response.ok) {
                alert(result.error || 'Failed to start AI correction');
                return;
            }
            alert('AI correction completed. Review the feedback and grade.');
            fetchSubmissions();
        } catch (error) {
            alert('Failed to start AI correction');
        }
    }

    function renderSubmissionCards(container, submissions, emptyMessage) {
        container.innerHTML = '';

        if (submissions.length > 0) {
            submissions.forEach((s) => {
                const div = document.createElement('div');
                const similarityFlag = hasSimilarityFlag(s);
                div.className = similarityFlag
                    ? 'border-2 border-red-400 p-3 rounded-md bg-red-50 flex justify-between items-center'
                    : 'border p-3 rounded-md bg-gray-50 flex justify-between items-center';
                const isSelectable = isSubmissionSelectable(s);
                const checkedAttr = selectedSubmissionIds.has(Number.parseInt(s.id, 10)) ? 'checked' : '';

                div.innerHTML = `
                    <div class="flex items-start gap-3">
                        ${isSelectable
                            ? `<label class="mt-1 flex items-center">
                                <input type="checkbox" class="select-submission-checkbox h-4 w-4" data-id="${s.id}" ${checkedAttr}>
                               </label>`
                            : '<span class="mt-1 inline-block h-4 w-4"></span>'}
                        <div>
                        <p class="font-bold">${formatStudentLabel(s.student_name, s)} (${s.group_name} - ${s.year})</p>
                        <p class="text-sm text-gray-600">${s.repo_url}</p>
                        <p class="text-xs text-gray-500 mt-1">Submitted: ${s.submission_date ? new Date(s.submission_date).toLocaleDateString() : 'Unknown date'}</p>
                        <div class="mt-2 space-x-2">
                            <span class="text-xs ${statusColors[s.status] || 'bg-gray-100'} px-2 py-1 rounded capitalize">
                                ${s.status}
                            </span>
                            ${similarityFlag ? '<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded font-semibold">Similarity Detected</span>' : ''}
                            ${s.grade !== null ? `<span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">Grade: ${s.grade}/20</span>` : ''}
                        </div>
                    </div>
                    </div>
                    <div class="flex space-x-2">
                        <button class="review-btn bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 text-sm" 
                            data-id="${s.id}">Review</button>
                        ${s.status !== 'approved' && s.status !== 'processing'
                            ? `<button class="start-correction-btn bg-amber-600 text-white px-3 py-1.5 rounded-md hover:bg-amber-700 text-sm" data-id="${s.id}">AI Correct</button>`
                            : ''}
                        <button class="delete-student-btn bg-red-100 text-red-600 px-3 py-1.5 rounded-md hover:bg-red-200 text-sm" 
                            data-student-id="${s.student_id}">Delete Student</button>
                    </div>
                `;

                div.querySelector('.review-btn').addEventListener('click', () => openReviewModal(s));
                const selectCheckbox = div.querySelector('.select-submission-checkbox');
                if (selectCheckbox) {
                    selectCheckbox.addEventListener('change', (event) => {
                        const parsedId = Number.parseInt(event.currentTarget.getAttribute('data-id'), 10);
                        if (!Number.isInteger(parsedId)) return;
                        if (event.currentTarget.checked) {
                            selectedSubmissionIds.add(parsedId);
                        } else {
                            selectedSubmissionIds.delete(parsedId);
                        }
                        updateSelectedCountLabel();
                    });
                }
                const startCorrectionBtn = div.querySelector('.start-correction-btn');
                if (startCorrectionBtn) {
                    startCorrectionBtn.addEventListener('click', async () => {
                        await startCorrectionForSubmission(s.id, s.correction_instructions || '');
                    });
                }

                div.querySelector('.delete-student-btn').addEventListener('click', async (e) => {
                    await handleDeleteStudent(e.currentTarget.getAttribute('data-student-id'), true);
                });

                container.appendChild(div);
            });
        } else {
            container.innerHTML = `<p class="text-gray-500 italic">${emptyMessage}</p>`;
        }
    }

    function renderStudents(students) {
        studentsList.innerHTML = '';

        if (students.length > 0) {
            students.forEach((student) => {
                const div = document.createElement('div');
                div.className = 'border p-4 rounded-md bg-white flex justify-between items-center';
                div.innerHTML = `
                    <div>
                        <p class="font-semibold">${formatStudentLabel(student.name, student)} (${student.group_name} - ${student.year})</p>
                        <p class="text-sm text-gray-600">${student.email}</p>
                        <p class="text-xs text-gray-500 mt-1">Submissions: ${student.submissions_count}</p>
                    </div>
                    <button class="delete-student-btn bg-red-100 text-red-600 px-3 py-2 rounded-md hover:bg-red-200"
                        data-student-id="${student.id}">Delete Student</button>
                `;

                div.querySelector('.delete-student-btn').addEventListener('click', async (e) => {
                    await handleDeleteStudent(e.currentTarget.getAttribute('data-student-id'), true);
                });

                studentsList.appendChild(div);
            });
        } else {
            studentsList.innerHTML = '<p class="text-gray-500 italic">No students found for current filters.</p>';
        }
    }

    function applyFiltersAndRender() {
        const filteredSubmissions = applyStudentFilters(allSubmissions);
        const unapproved = filteredSubmissions.filter((s) => s.status !== 'approved');
        const approved = filteredSubmissions.filter((s) => s.status === 'approved');

        if (submissionsListUnapproved) {
            renderSubmissionCards(
                submissionsListUnapproved,
                unapproved,
                'No not approved submissions found for current filters.'
            );
        }
        if (submissionsListApproved) {
            renderSubmissionCards(
                submissionsListApproved,
                approved,
                'No approved submissions found for current filters.'
            );
        }
        if (studentsList) renderStudents(applyStudentFilters(allStudents));
        updateSelectedCountLabel();
    }

    if (filterGroup) {
        filterGroup.addEventListener('input', applyFiltersAndRender);
    }
    if (filterYear) {
        filterYear.addEventListener('change', applyFiltersAndRender);
    }
    if (filterStudentName) {
        filterStudentName.addEventListener('input', applyFiltersAndRender);
    }
    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener('click', () => {
            if (filterGroup) filterGroup.value = '';
            if (filterYear) filterYear.value = '';
            if (filterStudentName) filterStudentName.value = '';
            applyFiltersAndRender();
        });
    }

    if (approveBulkBtn) {
        approveBulkBtn.addEventListener('click', async () => {
            const teacherFeedback = (bulkApproveFeedback ? bulkApproveFeedback.value : '').trim();
            const gradeInput = bulkApproveGrade ? String(bulkApproveGrade.value || '').trim() : '';
            const payload = {
                teacherId: currentTeacher.id,
                teacherFeedback,
                grade: gradeInput === '' ? null : Number.parseFloat(gradeInput),
                filters: buildFiltersPayload()
            };

            if (gradeInput !== '' && (Number.isNaN(payload.grade) || payload.grade < 0 || payload.grade > 20)) {
                alert('Fixed grade must be between 0 and 20.');
                return;
            }

            const confirmed = confirm('Approve all filtered pending submissions now?');
            if (!confirmed) return;

            try {
                const response = await fetch('/api/teacher/approve-bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                if (!response.ok) {
                    alert(result.error || 'Failed to approve filtered submissions');
                    return;
                }
                alert(result.message || 'Bulk approval completed.');
                fetchSubmissions();
            } catch (error) {
                alert('Failed to approve filtered submissions');
            }
        });
    }

    const runBulkApproveShortcut = (event) => {
        const isEnter = event.key === 'Enter' || event.code === 'NumpadEnter';
        const shouldSubmit = isEnter && (event.ctrlKey || event.metaKey);
        if (!shouldSubmit) return;
        event.preventDefault();
        if (approveBulkBtn) {
            approveBulkBtn.click();
        }
    };

    if (bulkApproveFeedback) {
        bulkApproveFeedback.addEventListener('keydown', runBulkApproveShortcut);
    }

    if (bulkApproveGrade) {
        bulkApproveGrade.addEventListener('keydown', runBulkApproveShortcut);
    }

    if (selectFilteredBtn) {
        selectFilteredBtn.addEventListener('click', () => {
            const ids = applyStudentFilters(allSubmissions)
                .filter((submission) => isSubmissionSelectable(submission))
                .map((submission) => Number.parseInt(submission.id, 10))
                .filter((id) => Number.isInteger(id));

            ids.forEach((id) => selectedSubmissionIds.add(id));
            applyFiltersAndRender();
        });
    }

    if (clearSelectionBtn) {
        clearSelectionBtn.addEventListener('click', () => {
            selectedSubmissionIds.clear();
            applyFiltersAndRender();
        });
    }

    if (cancelSelectedCorrectionsBtn) {
        cancelSelectedCorrectionsBtn.addEventListener('click', async () => {
            const selectedIds = getSelectedSubmissionIds();
            if (selectedIds.length === 0) {
                alert('Select at least one submission first.');
                return;
            }

            const confirmed = confirm(`Cancel current correction for ${selectedIds.length} selected submission(s)?`);
            if (!confirmed) return;

            const originalLabel = cancelSelectedCorrectionsBtn.textContent;
            cancelSelectedCorrectionsBtn.disabled = true;
            cancelSelectedCorrectionsBtn.textContent = 'Canceling...';

            try {
                const payload = JSON.stringify({
                    teacherId: currentTeacher.id,
                    submissionIds: selectedIds
                });
                const candidateEndpoints = [
                    '/api/teacher/cancel-corrections-selected',
                    '/api/teacher/cancel-selected-corrections'
                ];

                let handled = false;
                let lastErrorMessage = '';

                for (const endpoint of candidateEndpoints) {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: payload
                    });
                    const rawText = await response.text();
                    let result = {};
                    if (rawText) {
                        try {
                            result = JSON.parse(rawText);
                        } catch (jsonError) {
                            result = {};
                        }
                    }

                    if (response.ok) {
                        alert(result.message || 'Selected corrections canceled.');
                        fetchSubmissions();
                        handled = true;
                        break;
                    }

                    if (response.status === 404) {
                        lastErrorMessage = `Endpoint not found: ${endpoint}`;
                        continue;
                    }

                    const fallback = rawText ? rawText.slice(0, 180) : '';
                    alert(result.error || `Failed to cancel selected corrections (HTTP ${response.status})${fallback ? `: ${fallback}` : ''}`);
                    handled = true;
                    break;
                }

                if (!handled) {
                    // Older backends may not expose cancel endpoints.
                    // Do not block teacher flow: keep selection and allow "Start New Correction" fallback.
                    alert('Cancel endpoint is not available on this backend. You can still start a new correction for selected submissions.');
                }
            } catch (error) {
                alert(`Failed to cancel selected corrections: ${error.message || 'Network error'}`);
            } finally {
                cancelSelectedCorrectionsBtn.disabled = false;
                cancelSelectedCorrectionsBtn.textContent = originalLabel;
            }
        });
    }

    if (restartSelectedCorrectionsBtn) {
        restartSelectedCorrectionsBtn.addEventListener('click', async () => {
            const selectedIds = getSelectedSubmissionIds();
            if (selectedIds.length === 0) {
                alert('Select at least one submission first.');
                return;
            }

            const instructions = (bulkCorrectionInstructions ? bulkCorrectionInstructions.value : '').trim();
            if (!instructions) {
                alert('Please enter correction instructions (barem) before starting a new correction.');
                return;
            }

            const confirmed = confirm(`Start a new correction for ${selectedIds.length} selected submission(s)?`);
            if (!confirmed) return;

            const originalLabel = restartSelectedCorrectionsBtn.textContent;
            restartSelectedCorrectionsBtn.disabled = true;
            restartSelectedCorrectionsBtn.textContent = 'Starting New Correction...';

            try {
                const response = await fetch('/api/teacher/start-correction-selected', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        teacherId: currentTeacher.id,
                        submissionIds: selectedIds,
                        instructions
                    })
                });
                let result = {};
                try {
                    result = await response.json();
                } catch (error) {
                    result = {};
                }
                if (response.status === 404) {
                    let completed = 0;
                    let failed = 0;
                    for (const submissionId of selectedIds) {
                        try {
                            const oneResponse = await fetch('/api/teacher/start-correction', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    submissionId,
                                    teacherId: currentTeacher.id,
                                    instructions
                                })
                            });
                            if (oneResponse.ok) completed += 1;
                            else failed += 1;
                        } catch (error) {
                            failed += 1;
                        }
                    }
                    alert(`New correction finished for selected submissions. Completed: ${completed}, failed: ${failed}, total: ${selectedIds.length}.`);
                    fetchSubmissions();
                    return;
                }
                if (!response.ok) {
                    alert(result.error || 'Failed to start new correction for selected submissions');
                    return;
                }
                alert(result.message || 'New correction run completed for selected submissions.');
                fetchSubmissions();
            } catch (error) {
                alert('Failed to start new correction for selected submissions');
            } finally {
                restartSelectedCorrectionsBtn.disabled = false;
                restartSelectedCorrectionsBtn.textContent = originalLabel;
            }
        });
    }

    async function runBulkCorrectionForFilters() {
        if (!bulkCorrectionBtn) return;
        if (bulkCorrectionBtn.disabled) return;

        const instructions = (bulkCorrectionInstructions ? bulkCorrectionInstructions.value : '').trim();
        if (!instructions) {
            alert('Please enter correction instructions (barem) for bulk AI correction.');
            return;
        }

        const confirmed = confirm('Run AI correction with this same barème for all currently filtered non-approved submissions?');
        if (!confirmed) return;

        const originalLabel = bulkCorrectionBtn.textContent;
        bulkCorrectionBtn.disabled = true;
        bulkCorrectionBtn.textContent = 'Running AI Correction...';

        const runFallbackCorrection = async () => {
            const targets = applyStudentFilters(allSubmissions).filter((s) => s.status !== 'approved' && s.status !== 'processing');
            if (targets.length === 0) {
                alert('No non-approved submissions found for current filters.');
                return;
            }

            let completed = 0;
            let failed = 0;

            for (const submission of targets) {
                try {
                    const response = await fetch('/api/teacher/start-correction', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            submissionId: submission.id,
                            teacherId: currentTeacher.id,
                            instructions
                        })
                    });
                    if (response.ok) {
                        completed += 1;
                    } else {
                        failed += 1;
                    }
                } catch (error) {
                    failed += 1;
                }
            }

            alert(`Bulk AI correction finished. Completed: ${completed}, failed: ${failed}, total: ${targets.length}.`);
            fetchSubmissions();
        };

        try {
            const response = await fetch('/api/teacher/start-correction-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    teacherId: currentTeacher.id,
                    instructions,
                    filters: buildFiltersPayload()
                })
            });

            let result = {};
            try {
                result = await response.json();
            } catch (error) {
                result = {};
            }

            if (!response.ok) {
                if (response.status === 404) {
                    await runFallbackCorrection();
                    return;
                }
                alert(result.error || `Failed to run bulk AI correction (HTTP ${response.status})`);
                return;
            }

            alert(result.message || 'Bulk AI correction completed.');
            fetchSubmissions();
        } catch (error) {
            await runFallbackCorrection();
        } finally {
            bulkCorrectionBtn.disabled = false;
            bulkCorrectionBtn.textContent = originalLabel;
        }
    }

    if (bulkCorrectionBtn) {
        bulkCorrectionBtn.addEventListener('click', runBulkCorrectionForFilters);
    }

    if (bulkCorrectionInstructions) {
        bulkCorrectionInstructions.addEventListener('keydown', (event) => {
            const isEnter = event.key === 'Enter' || event.code === 'NumpadEnter';
            const shouldSubmit = isEnter && (event.ctrlKey || event.metaKey);
            if (!shouldSubmit) return;
            event.preventDefault();
            runBulkCorrectionForFilters();
        });
    }

    function showDashboard() {
        const teacherId = Number.parseInt(currentTeacher && currentTeacher.id, 10);
        if (!Number.isInteger(teacherId)) {
            localStorage.removeItem('teacher');
            alert('Your session is invalid. Please log in again.');
            window.location.href = '/teacher/index.html';
            return;
        }

        currentTeacher.id = teacherId;
        loginSection.classList.add('hidden');
        dashboardSection.classList.remove('hidden');
        fetchSubmissions();
        if (studentsList) fetchStudents();
    }

    async function deleteStudent(studentId) {
        if (!studentId) {
            alert('Invalid student id');
            return false;
        }

        const response = await fetch(`/api/teacher/students/${studentId}`, {
            method: 'DELETE'
        });

        let payload = {};
        try {
            payload = await response.json();
        } catch (error) {
            // Ignore JSON parsing issues and handle via status fallback.
        }

        if (!response.ok) {
            const errorMessage = payload.error || `Delete failed (HTTP ${response.status})`;
            throw new Error(errorMessage);
        }

        alert(payload.message || 'Student deleted successfully.');
        return true;
    }

    async function fetchSubmissions() {
        if (!currentTeacher || !Number.isInteger(currentTeacher.id)) return;

        try {
            const response = await fetch(`/api/teacher/submissions?teacherId=${encodeURIComponent(currentTeacher.id)}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            allSubmissions = await response.json();
            syncSelectedSubmissionIdsWithData();
            applyFiltersAndRender();
        } catch (error) {
            console.error('Error fetching submissions:', error);
            if (submissionsListUnapproved) {
                submissionsListUnapproved.innerHTML = '<p class="text-red-500 italic">Failed to load submissions.</p>';
            }
            if (submissionsListApproved) {
                submissionsListApproved.innerHTML = '<p class="text-red-500 italic">Failed to load submissions.</p>';
            }
        }
    }

    async function fetchStudents() {
        if (!studentsList) return;
        if (!currentTeacher || !Number.isInteger(currentTeacher.id)) return;

        try {
            const response = await fetch(`/api/teacher/students?teacherId=${encodeURIComponent(currentTeacher.id)}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            allStudents = await response.json();
            applyFiltersAndRender();
        } catch (error) {
            console.error('Error fetching students:', error);
            studentsList.innerHTML = '<p class="text-red-500 italic">Failed to load students.</p>';
        }
    }

    async function openReviewModal(submission) {
        activeSubmissionId = submission.id;
        const studentCode = resolveStudentCode(submission);
        modalStudentName.textContent = `${submission.student_name} [ID: ${studentCode}]`;
        modalRepoLink.textContent = submission.repo_url;
        modalRepoLink.href = submission.repo_url;
        modalAiFeedback.textContent = submission.ai_feedback || 'No evaluation notes available.';
        modalGrade.value = submission.grade || 0;
        modalTeacherFeedback.value = submission.teacher_feedback || submission.ai_feedback || '';
        
        // Reset state
        modalTeacherFeedback.disabled = false;
        modalGrade.disabled = false;
        approveBtn.classList.remove('hidden');
        if (startCorrectionSection) startCorrectionSection.classList.remove('hidden');
        if (correctionInstructions) correctionInstructions.value = submission.correction_instructions || '';
        
        if (submission.status === 'processing') {
            approveBtn.classList.add('hidden');
            if (startCorrectionSection) startCorrectionSection.classList.add('hidden');
            modalAiFeedback.textContent = 'Evaluation is currently processing.';
        } else if (submission.status === 'approved') {
            approveBtn.classList.add('hidden');
            if (startCorrectionSection) startCorrectionSection.classList.add('hidden');
            modalTeacherFeedback.disabled = true;
            modalGrade.disabled = true;
        }

        setReviewModalVisibility(true);
    }

    if (startAiBtn) {
        startAiBtn.addEventListener('click', async () => {
            const instructions = (correctionInstructions ? correctionInstructions.value : '').trim();
            if (!instructions) {
                alert('Please enter correction instructions (barem).');
                return;
            }

            try {
                const response = await fetch('/api/teacher/start-correction', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        submissionId: activeSubmissionId,
                        teacherId: currentTeacher.id,
                        instructions
                    })
                });
                const result = await response.json();
                if (!response.ok) {
                    alert(result.error || 'Failed to start AI correction');
                    return;
                }
                alert('AI correction completed. Review the feedback and grade.');
                setReviewModalVisibility(false);
                fetchSubmissions();
            } catch (error) {
                alert('Failed to start AI correction');
            }
        });
    }

    if (closeModal) {
        closeModal.addEventListener('click', () => {
            setReviewModalVisibility(false);
        });
    }

    if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
        const data = {
            submissionId: activeSubmissionId,
            teacherFeedback: modalTeacherFeedback.value,
            grade: parseFloat(modalGrade.value), // We could also update the grade if the teacher changed it
            teacherId: currentTeacher.id
        };

        try {
            const response = await fetch('/api/teacher/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            if (!response.ok) {
                alert(result.error || 'Failed to approve grade');
                return;
            }
            setReviewModalVisibility(false);
            fetchSubmissions();
        } catch (error) {
            alert('Failed to approve grade');
        }
        });
    }

    // Refresh every 30 seconds
    setInterval(() => {
        if (currentTeacher) {
            fetchSubmissions();
            if (studentsList) fetchStudents();
        }
    }, 30000);
});
