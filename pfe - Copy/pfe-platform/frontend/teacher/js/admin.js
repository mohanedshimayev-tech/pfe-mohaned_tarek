document.addEventListener('DOMContentLoaded', () => {
    const addTeacherForm = document.getElementById('add-teacher-form');
    const newTeacherName = document.getElementById('new-teacher-name');
    const newTeacherPassword = document.getElementById('new-teacher-password');
    const teachersList = document.getElementById('teachers-list');
    const addTeacherStatus = document.getElementById('add-teacher-status');
    const adminLogoutBtn = document.getElementById('admin-logout-btn');
    const deleteAllStudentsBtn = document.getElementById('delete-all-students-btn');

    const adminPassword = localStorage.getItem('admin_password');
    const normalizeTeacherKey = (name) => (name || '').trim().toLowerCase();
    const teacherPasswordOverrides = JSON.parse(localStorage.getItem('teacher_password_overrides') || '{}');
    Object.keys(teacherPasswordOverrides).forEach((key) => {
        const normalizedKey = normalizeTeacherKey(key);
        if (normalizedKey && normalizedKey !== key && !Object.prototype.hasOwnProperty.call(teacherPasswordOverrides, normalizedKey)) {
            teacherPasswordOverrides[normalizedKey] = teacherPasswordOverrides[key];
            delete teacherPasswordOverrides[key];
        }
    });
    localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
    if (!adminPassword) {
        window.location.href = '/teacher/index.html';
        return;
    }

    adminLogoutBtn.addEventListener('click', () => {
        localStorage.removeItem('admin_password');
        localStorage.removeItem('teacher');
        window.location.href = '/index.html';
    });

    async function parseJsonResponse(response) {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error(`Admin API not available (HTTP ${response.status}).`);
        }
        return response.json();
    }

    async function loadTeachers() {
        try {
            const response = await fetch('/api/teacher/list');
            const payload = await parseJsonResponse(response);
            if (!response.ok || !Array.isArray(payload)) {
                throw new Error((payload && payload.error) || 'Failed to load teachers');
            }

            if (payload.length === 0) {
                teachersList.innerHTML = '<p class="text-gray-500 italic">No teachers found.</p>';
                return;
            }

            teachersList.innerHTML = payload.map((teacher) => `
                <div class="border rounded p-3 bg-gray-50">
                    <p><span class="font-semibold">Name:</span> ${teacher.name}</p>
                    <p class="text-xs text-gray-700 mt-1"><span class="font-semibold">Current Password:</span> <span id="shown-password-${teacher.id}">${teacherPasswordOverrides[normalizeTeacherKey(teacher.name)] || 'Hidden'}</span></p>
                    <div class="flex gap-2 mt-2">
                        <button class="view-password-btn bg-indigo-600 text-white text-xs px-2 py-1 rounded hover:bg-indigo-700"
                            data-teacher-id="${teacher.id}" data-teacher-name="${teacher.name}">View Password</button>
                        <button class="delete-teacher-btn bg-red-600 text-white text-xs px-2 py-1 rounded hover:bg-red-700"
                            data-teacher-id="${teacher.id}" data-teacher-name="${teacher.name}">Delete</button>
                    </div>
                    <div class="mt-2 flex gap-2">
                        <input id="new-password-${teacher.id}" type="text" class="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" placeholder="New password">
                        <button class="change-password-btn bg-green-600 text-white text-xs px-2 py-1 rounded hover:bg-green-700"
                            data-teacher-id="${teacher.id}" data-teacher-name="${teacher.name}">Change Password</button>
                    </div>
                </div>
            `).join('');

            teachersList.querySelectorAll('.view-password-btn').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const teacherId = e.currentTarget.getAttribute('data-teacher-id');
                    const teacherName = e.currentTarget.getAttribute('data-teacher-name');
                    const shownPasswordEl = document.getElementById(`shown-password-${teacherId}`);
                    const teacherKey = normalizeTeacherKey(teacherName);
                    try {
                        const revealResponse = await fetch(`/api/admin/teachers/${teacherId}/reveal-password`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ adminPassword })
                        });
                        const revealPayload = await parseJsonResponse(revealResponse);
                        if (!revealResponse.ok) {
                            throw new Error(revealPayload.error || 'Failed to view password');
                        }
                        shownPasswordEl.textContent = revealPayload.password;
                        shownPasswordEl.className = 'text-green-700 font-semibold';
                        teacherPasswordOverrides[teacherKey] = revealPayload.password;
                        localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
                    } catch (error) {
                        shownPasswordEl.textContent = teacherPasswordOverrides[teacherKey] || 'admin (legacy mode)';
                        shownPasswordEl.className = 'text-yellow-700 font-semibold';
                    }
                });
            });

            teachersList.querySelectorAll('.delete-teacher-btn').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const teacherId = e.currentTarget.getAttribute('data-teacher-id');
                    const teacherName = e.currentTarget.getAttribute('data-teacher-name');
                    const teacherKey = normalizeTeacherKey(teacherName);
                    if (!confirm(`Delete teacher "${teacherName}"?`)) return;

                    try {
                        const deleteResponse = await fetch(`/api/admin/teachers/${teacherId}`, {
                            method: 'DELETE',
                            headers: {
                                'x-admin-password': adminPassword
                            }
                        });
                        const deletePayload = await parseJsonResponse(deleteResponse);
                        if (!deleteResponse.ok) {
                            throw new Error(deletePayload.error || 'Failed to delete teacher');
                        }
                        delete teacherPasswordOverrides[teacherKey];
                        localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
                        addTeacherStatus.textContent = deletePayload.message || 'Teacher deleted.';
                        addTeacherStatus.className = 'text-sm mt-3 text-green-600';
                        await loadTeachers();
                    } catch (error) {
                        addTeacherStatus.textContent = 'Delete requires latest backend admin APIs.';
                        addTeacherStatus.className = 'text-sm mt-3 text-red-600';
                    }
                });
            });

            teachersList.querySelectorAll('.change-password-btn').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const teacherId = e.currentTarget.getAttribute('data-teacher-id');
                    const teacherName = e.currentTarget.getAttribute('data-teacher-name');
                    const teacherKey = normalizeTeacherKey(teacherName);
                    const newPasswordInput = document.getElementById(`new-password-${teacherId}`);
                    const shownPasswordEl = document.getElementById(`shown-password-${teacherId}`);
                    const newPassword = (newPasswordInput ? newPasswordInput.value : '').trim();

                    if (!newPassword) {
                        addTeacherStatus.textContent = 'Please provide a new password.';
                        addTeacherStatus.className = 'text-sm mt-3 text-red-600';
                        return;
                    }

                    try {
                        const updateResponse = await fetch(`/api/admin/teachers/${teacherId}/password`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                adminPassword,
                                newPassword
                            })
                        });
                        const updatePayload = await parseJsonResponse(updateResponse);
                        if (!updateResponse.ok) {
                            throw new Error(updatePayload.error || 'Failed to update password');
                        }

                        addTeacherStatus.textContent = updatePayload.message || `Password updated for ${teacherName}.`;
                        addTeacherStatus.className = 'text-sm mt-3 text-green-600';
                        if (shownPasswordEl) {
                            shownPasswordEl.textContent = newPassword;
                            shownPasswordEl.className = 'text-green-700 font-semibold';
                        }
                        teacherPasswordOverrides[teacherKey] = newPassword;
                        localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
                        if (newPasswordInput) newPasswordInput.value = '';
                    } catch (error) {
                        // Legacy fallback: save password locally when admin API is unavailable.
                        teacherPasswordOverrides[teacherKey] = newPassword;
                        localStorage.setItem('teacher_password_overrides', JSON.stringify(teacherPasswordOverrides));
                        addTeacherStatus.textContent = `Password saved locally for ${teacherName} (legacy mode).`;
                        addTeacherStatus.className = 'text-sm mt-3 text-yellow-700';
                        if (shownPasswordEl) {
                            shownPasswordEl.textContent = newPassword;
                            shownPasswordEl.className = 'text-yellow-700 font-semibold';
                        }
                        if (newPasswordInput) newPasswordInput.value = '';
                    }
                });
            });
        } catch (error) {
            const fallbackNames = ['tarek1', 'tarek2', 'tarek3', 'tarek4', 'tarek5', 'tarek6'];
            teachersList.innerHTML = `
                <p class="text-red-500 text-xs mb-2">${error.message}</p>
                ${fallbackNames.map((name) => `
                    <div class="border rounded p-2 bg-gray-50 mb-2">
                        <p><span class="font-semibold">Name:</span> ${name}</p>
                    </div>
                `).join('')}
            `;
        }
    }

    addTeacherForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = (newTeacherName.value || '').trim();
        const password = (newTeacherPassword.value || '').trim();

        if (!name || !password) {
            addTeacherStatus.textContent = 'Teacher name and password are required.';
            addTeacherStatus.className = 'text-sm mt-3 text-red-600';
            return;
        }

        try {
            const response = await fetch('/api/admin/teachers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adminPassword,
                    name,
                    password
                })
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok) {
                throw new Error(payload.error || 'Failed to add teacher');
            }

            addTeacherStatus.textContent = `Teacher "${payload.name}" added successfully.`;
            addTeacherStatus.className = 'text-sm mt-3 text-green-600';
            newTeacherName.value = '';
            newTeacherPassword.value = '';
            await loadTeachers();
        } catch (error) {
            try {
                const legacyResponse = await fetch('/api/teacher/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        teacherName: name,
                        password: 'admin'
                    })
                });
                const legacyPayload = await parseJsonResponse(legacyResponse);
                if (!legacyResponse.ok) {
                    throw new Error(legacyPayload.error || 'Legacy add teacher failed');
                }
                addTeacherStatus.textContent = `Teacher "${name}" added in legacy mode (password = admin).`;
                addTeacherStatus.className = 'text-sm mt-3 text-yellow-700';
                newTeacherName.value = '';
                newTeacherPassword.value = '';
                await loadTeachers();
            } catch (legacyError) {
                addTeacherStatus.textContent = `Failed to add teacher: ${legacyError.message}`;
                addTeacherStatus.className = 'text-sm mt-3 text-red-600';
            }
        }
    });

    if (deleteAllStudentsBtn) {
        deleteAllStudentsBtn.addEventListener('click', async () => {
            const firstConfirm = confirm('Delete ALL students and ALL submissions? This cannot be undone.');
            if (!firstConfirm) return;

            const secondConfirm = confirm('Final confirmation: this will permanently erase all student data.');
            if (!secondConfirm) return;

            const originalLabel = deleteAllStudentsBtn.textContent;
            deleteAllStudentsBtn.disabled = true;
            deleteAllStudentsBtn.textContent = 'Deleting...';

            try {
                const response = await fetch('/api/admin/students', {
                    method: 'DELETE',
                    headers: {
                        'x-admin-password': adminPassword
                    }
                });
                if (response.status === 404) {
                    // Legacy fallback for backends without /api/admin/students.
                    const teacherResponse = await fetch('/api/teacher/list');
                    const teachersPayload = await parseJsonResponse(teacherResponse);
                    if (!teacherResponse.ok || !Array.isArray(teachersPayload)) {
                        throw new Error('Failed to load teachers for legacy deletion flow');
                    }

                    const allStudentIds = new Set();
                    for (const teacher of teachersPayload) {
                        const studentsResponse = await fetch(`/api/teacher/students?teacherId=${encodeURIComponent(teacher.id)}`);
                        const studentsPayload = await parseJsonResponse(studentsResponse);
                        if (!studentsResponse.ok || !Array.isArray(studentsPayload)) continue;
                        studentsPayload.forEach((student) => {
                            const id = Number.parseInt(student.id, 10);
                            if (Number.isInteger(id)) allStudentIds.add(id);
                        });
                    }

                    let deletedStudents = 0;
                    for (const studentId of allStudentIds) {
                        const deleteResponse = await fetch(`/api/teacher/students/${studentId}`, { method: 'DELETE' });
                        if (deleteResponse.ok) deletedStudents += 1;
                    }

                    addTeacherStatus.textContent = `Deleted ${deletedStudents} student(s) in legacy mode.`;
                    addTeacherStatus.className = 'text-sm mt-3 text-green-600';
                    return;
                }

                const payload = await parseJsonResponse(response);
                if (!response.ok) {
                    throw new Error(payload.error || 'Failed to delete students');
                }

                addTeacherStatus.textContent = payload.message || 'All students deleted.';
                addTeacherStatus.className = 'text-sm mt-3 text-green-600';
            } catch (error) {
                addTeacherStatus.textContent = `Failed to delete all students: ${error.message}`;
                addTeacherStatus.className = 'text-sm mt-3 text-red-600';
            } finally {
                deleteAllStudentsBtn.disabled = false;
                deleteAllStudentsBtn.textContent = originalLabel;
            }
        });
    }

    loadTeachers();
});
