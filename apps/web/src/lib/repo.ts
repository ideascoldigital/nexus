/**
 * The GitHub repository this install was built from. One place so the
 * statusbar links, the update check and the release URLs all agree.
 * Overridable for forks via env.
 */
export const REPO = process.env.NEXUX_REPO || "ideascoldigital/nexus";
export const REPO_URL = `https://github.com/${REPO}`;
