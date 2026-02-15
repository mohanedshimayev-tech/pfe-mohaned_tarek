const axios = require('axios');

/**
 * Agent responsible for retrieving repository information from GitHub.
 */
class RepoRetriever {
    constructor(token = process.env.GITHUB_TOKEN || null) {
        this.token = token;
        this.baseUrl = 'https://api.github.com/repos';
        this.maxFilesForAnalysis = Number.parseInt(process.env.REPO_MAX_FILES_FOR_ANALYSIS || '60', 10);
        this.maxCharsPerFile = Number.parseInt(process.env.REPO_MAX_CHARS_PER_FILE || '8000', 10);
        this.requestTimeoutMs = 15000;
        this.maxRequestRetries = 3;
    }

    isRetryableError(error) {
        const message = String(error && error.message ? error.message : '').toLowerCase();
        const code = String(error && error.code ? error.code : '').toUpperCase();
        const status = error && error.response && error.response.status;

        if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
            return true;
        }
        if (message.includes('eai_again') || message.includes('socket hang up') || message.includes('timeout')) {
            return true;
        }
        if (status === 429) return true;
        if (Number.isInteger(status) && status >= 500) return true;
        return false;
    }

    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async githubGet(url, config = {}) {
        let lastError = null;
        const baseConfig = {
            timeout: this.requestTimeoutMs,
            ...config
        };

        for (let attempt = 0; attempt <= this.maxRequestRetries; attempt += 1) {
            try {
                return await axios.get(url, baseConfig);
            } catch (error) {
                lastError = error;
                const shouldRetry = attempt < this.maxRequestRetries && this.isRetryableError(error);
                if (!shouldRetry) break;
                const backoffMs = 600 * (attempt + 1);
                await this.sleep(backoffMs);
            }
        }

        throw lastError;
    }

    isLikelySourceFile(path) {
        const lower = path.toLowerCase();
        const blocked = ['node_modules/', '.git/', 'dist/', 'build/', 'coverage/', 'vendor/', 'bin/'];
        if (blocked.some((prefix) => lower.includes(prefix))) return false;

        const allowedExt = [
            '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs',
            '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.html', '.css', '.sql', '.md', '.json'
        ];
        return allowedExt.some((ext) => lower.endsWith(ext));
    }

    async fetchFileContent(owner, repo, filePath, config) {
        try {
            const encodedPath = filePath
                .split('/')
                .map((segment) => encodeURIComponent(segment))
                .join('/');
            const response = await this.githubGet(`${this.baseUrl}/${owner}/${repo}/contents/${encodedPath}`, config);
            if (!response.data || response.data.type !== 'file' || !response.data.content) return null;
            const decoded = Buffer.from(response.data.content, 'base64').toString('utf8');
            return decoded.slice(0, this.maxCharsPerFile);
        } catch (error) {
            return null;
        }
    }

    async getRepoInfo(repoUrl) {
        try {
            // Robustly extract owner and repo name from URL
            const url = repoUrl.endsWith('/') ? repoUrl.slice(0, -1) : repoUrl;
            const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
            
            if (!match) throw new Error('Invalid GitHub URL format.');
            
            const owner = match[1];
            const repo = match[2].replace(/\.git$/i, '');

            const config = this.token ? { headers: { Authorization: `token ${this.token}` } } : {};
            
            const response = await this.githubGet(`${this.baseUrl}/${owner}/${repo}`, config);
            const contents = await this.githubGet(`${this.baseUrl}/${owner}/${repo}/contents`, config);

            let treeFiles = [];
            try {
                const defaultBranch = response.data.default_branch || 'main';
                const treeResponse = await this.githubGet(`${this.baseUrl}/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, config);
                treeFiles = Array.isArray(treeResponse.data.tree)
                    ? treeResponse.data.tree
                        .filter((entry) => entry.type === 'blob' && this.isLikelySourceFile(entry.path))
                        .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
                        .slice(0, this.maxFilesForAnalysis)
                    : [];
            } catch (treeError) {
                // Fallback to root contents if recursive tree fetch fails.
                treeFiles = Array.isArray(contents.data)
                    ? contents.data
                        .filter((entry) => entry.type === 'file' && this.isLikelySourceFile(entry.path))
                        .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
                        .slice(0, this.maxFilesForAnalysis)
                    : [];
            }

            const codeSnippets = [];
            for (const file of treeFiles) {
                const snippet = await this.fetchFileContent(owner, repo, file.path, config);
                if (snippet && snippet.trim()) {
                    codeSnippets.push({
                        path: file.path,
                        snippet
                    });
                }
            }

            return {
                owner,
                repo,
                name: response.data.name,
                description: response.data.description,
                files: Array.isArray(contents.data) ? contents.data.map(file => ({
                    name: file.name,
                    path: file.path,
                    type: file.type
                })) : [],
                codeSnippets
            };
        } catch (error) {
            console.error('Error retrieving repo:', error.message);
            const statusCode = error && error.response && error.response.status
                ? error.response.status
                : null;
            const apiMessage = error && error.response && error.response.data && error.response.data.message
                ? error.response.data.message
                : error.message;
            if (statusCode) {
                throw new Error(`Failed to retrieve repository (GitHub ${statusCode}): ${apiMessage}`);
            }
            throw new Error(`Failed to retrieve repository: ${apiMessage}`);
        }
    }
}

module.exports = new RepoRetriever();
