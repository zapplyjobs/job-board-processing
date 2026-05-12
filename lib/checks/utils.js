/**
 * Shared utilities for pipeline alert checks.
 */

const https = require('https');

function ghRequest(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Zapply-Pipeline-Alert',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    }).on('error', reject);
  });
}

async function getLastWorkflowRun(owner, repo, workflowFile, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`;
  try {
    const res = await ghRequest(url, token);
    if (res.status !== 200 || !res.body?.workflow_runs?.length) return null;
    return res.body.workflow_runs[0];
  } catch {
    return null;
  }
}

module.exports = { ghRequest, getLastWorkflowRun };
