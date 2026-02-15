# TODO: Implement Secure Teacher Authentication

## Steps to Complete

- [x] Add bcrypt dependency to package.json
- [x] Update server.js to use bcrypt for password hashing and comparison
- [x] Update seed.sql to store hashed passwords instead of plain text
- [x] Run npm install to install bcrypt
- [x] Test teacher login functionality

## Details

- **Add bcrypt to package.json**: Add "bcrypt": "^5.1.0" to dependencies.
- **Update server.js**:
  - Require bcrypt.
  - In teacher login, use email for lookup, hash input password and compare.
  - When inserting teacher (in login if not exists), hash the password.
- **Update seed.sql**: Replace plain text passwords with bcrypt hashes (e.g., for 'password123' and 'admin').
- **Run npm install**: Execute `npm install` in the project directory.
- **Test**: Verify login works with hashed passwords.
