const axios = require('axios');

/**
 * Helper class for interacting with GitHub API.
 */
class GithubIntegration {
    constructor(token = process.env.GITHUB_TOKEN) {
        this.token = token;
        this.client = axios.create({
            baseURL: 'https://api.github.com',
            headers: {
                Authorization: this.token ? `token ${this.token}` : undefined,
                Accept: 'application/vnd.github.v3+json'
            }
        });
    }

    async getRepository(owner, repo) {
        return this.client.get(`/repos/${owner}/${repo}`);
    }

    async getContents(owner, repo, path = '') {
        return this.client.get(`/repos/${owner}/${repo}/contents/${path}`);
    }

    async getWorkflows(owner, repo) {
        return this.client.get(`/repos/${owner}/${repo}/actions/workflows`);
    }
}

module.exports = GithubIntegration;
