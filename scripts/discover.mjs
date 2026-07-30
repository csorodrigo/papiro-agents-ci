const projects = {
  lucrandoai: "csorodrigo/lucrando-ai",
  papiro: "csorodrigo/papiro",
};
const branchPattern = /^agent\/ops-[0-9a-f]{16}$/;
const token = process.env.BROKER_GITHUB_TOKEN;
const outputPath = process.env.GITHUB_OUTPUT;
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

if (!token || !outputPath) {
  throw new Error("required GitHub workflow environment is unavailable");
}

async function request(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : {};
}

async function branchesFor(project, repository) {
  const requestedProject =
    process.env.INPUT_PROJECT && process.env.INPUT_PROJECT !== "all"
      ? process.env.INPUT_PROJECT
      : "";
  const requestedBranch = process.env.INPUT_BRANCH || "";
  if (requestedProject && requestedProject !== project) return [];
  if (requestedBranch) {
    if (!branchPattern.test(requestedBranch)) {
      throw new Error("manual branch is outside agent/ops-<16 hex> policy");
    }
    const branch = await request(
      `/repos/${repository}/branches/${encodeURIComponent(requestedBranch)}`,
    );
    return [{ name: branch.name, commit: branch.commit }];
  }
  const branches = await request(`/repos/${repository}/branches?per_page=100`);
  return branches.filter((branch) => branchPattern.test(branch.name));
}

const include = [];
for (const [project, repository] of Object.entries(projects)) {
  for (const branch of await branchesFor(project, repository)) {
    const sha = branch?.commit?.sha;
    if (!/^[0-9a-f]{40}$/.test(sha || "")) {
      throw new Error("branch returned an invalid head SHA");
    }
    const status = await request(`/repos/${repository}/commits/${sha}/status`);
    const terminal = (status.statuses || []).find(
      (item) =>
        item.context === "hermes-agent-ci" &&
        ["success", "failure", "error"].includes(item.state),
    );
    if (terminal) continue;
    await request(`/repos/${repository}/statuses/${sha}`, {
      method: "POST",
      body: JSON.stringify({
        state: "pending",
        context: "hermes-agent-ci",
        description: "Hermes isolated validation queued",
        target_url: runUrl,
      }),
    });
    include.push({
      project,
      repository,
      branch: branch.name,
      sha,
    });
  }
}

include.sort((left, right) =>
  `${left.project}:${left.branch}`.localeCompare(`${right.project}:${right.branch}`),
);
if (include.length > 4) include.length = 4;

const fs = await import("node:fs");
fs.appendFileSync(outputPath, `has_work=${include.length ? "true" : "false"}\n`);
fs.appendFileSync(outputPath, `matrix=${JSON.stringify({ include })}\n`);
console.log(`discovered=${include.length}`);
