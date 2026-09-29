// SPDX-License-Identifier: GPL-3.0-or-later
import {createHash} from 'node:crypto';
import {fail, githubRepo} from './validation.js';

// Persisted legacy values fail closed; request validation remains strict.
export const canonicalClassification = value => value === 'official' ? 'official' : 'community';
const repository = value => {
  if (!value) return null;
  try { return githubRepo(value).url.toLowerCase(); } catch { return value; }
};

// Only project selectors belong here, not release versions, content or distribution.
export function projectIdentity(row) {
  const github = row.github_json ? JSON.parse(row.github_json) : null;
  const source = row.source_type === 'github' ? repository(row.source_url) : row.source_url;
  return {
    sourceType:row.source_type, sourceUrl:source, type:row.product_type,
    websiteUrl:row.website_url || null,
    repository:row.source_type === 'github' ? repository(github?.owner && github?.repo ? `https://github.com/${github.owner}/${github.repo}` : source) : null,
    extensionId:github?.manifest?.id || null,
    manifestRepository:github?.manifest ? repository(github.manifest.repository || source) : null,
  };
}
// A derived approval precondition, not another persisted identity or permission.
export const projectIdentityKey = row => createHash('sha256').update(JSON.stringify({id:row.id, ...projectIdentity(row)})).digest('hex');
export function assertOfficialProject(current, candidate) {
  if (canonicalClassification(current.classification) === 'official' && projectIdentityKey(current) !== projectIdentityKey(candidate)) {
    fail(409, 'official_project_identity_mismatch', '官方项目身份发生变化；请由 Owner 先设为社区扩展，修改项目后再重新确认官方身份');
  }
}
