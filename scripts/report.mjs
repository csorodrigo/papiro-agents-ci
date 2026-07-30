import fs from "node:fs";
import path from "node:path";

const projects = {
  lucrandoai: "csorodrigo/lucrando-ai",
  papiro: "csorodrigo/papiro",
};
const branchPattern = /^agent\/ops-[0-9a-f]{16}$/;
const token = process.env.BROKER_GITHUB_TOKEN;
const resultsRoot = process.argv[2];
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

if (!token || !resultsRoot) {
  throw new Error("report environment is incomplete");
}

async function request(apiPath, options = {}, accepted = [200, 201]) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!accepted.includes(response.status)) {
    throw new Error(
      `GitHub API ${response.status} for ${apiPath}: ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

function resultFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = entry.isDirectory()
      ? path.join(root, entry.name, "result.json")
      : path.join(root, entry.name);
    if (candidate.endsWith("result.json") && fs.existsSync(candidate)) {
      files.push(candidate);
    }
  }
  return files;
}

let reported = 0;
let checks = 0;
let drafts = 0;
for (const file of resultFiles(resultsRoot)) {
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    result.version !== 1 ||
    projects[result.project] !== result.repository ||
    !branchPattern.test(result.branch) ||
    !/^[0-9a-f]{40}$/.test(result.sha) ||
    !["success", "failure"].includes(result.conclusion) ||
    !Array.isArray(result.commands)
  ) {
    throw new Error("validation artifact failed schema or scope policy");
  }

  const ref = await request(
    `/repos/${result.repository}/git/ref/heads/${result.branch
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  if (ref?.object?.sha !== result.sha) {
    throw new Error("branch head moved after validation");
  }

  await request(`/repos/${result.repository}/statuses/${result.sha}`, {
    method: "POST",
    body: JSON.stringify({
      state: result.conclusion,
      context: "hermes-agent-ci",
      description:
        result.conclusion === "success"
          ? "Hermes isolated validation passed"
          : "Hermes isolated validation failed",
      target_url: runUrl,
    }),
  });
  reported += 1;
  try {
    await request(`/repos/${result.repository}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "Hermes Agent CI",
        head_sha: result.sha,
        status: "completed",
        conclusion: result.conclusion,
        details_url: runUrl,
        output: {
          title:
            result.conclusion === "success"
              ? "Isolated validation passed"
              : "Isolated validation failed",
          summary: [
            `Project: ${result.project}`,
            `Branch: ${result.branch}`,
            `Head SHA: ${result.sha}`,
            "",
            ...result.commands.map((command) => `- \`${command}\``),
            "",
            "No merge or deploy was performed.",
          ].join("\n"),
        },
      }),
    });
    checks += 1;
  } catch (error) {
    console.log(`check_run_unavailable=${result.repository}:${error.message.slice(0, 120)}`);
  }

  if (result.conclusion !== "success") continue;
  const [owner] = result.repository.split("/");
  const pulls = await request(
    `/repos/${result.repository}/pulls?state=open&head=${encodeURIComponent(
      `${owner}:${result.branch}`,
    )}`,
  );
  if (pulls.length) continue;
  const taskId = result.branch.slice("agent/".length);
  await request(`/repos/${result.repository}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `[agent] ${taskId}`,
      head: result.branch,
      base: "main",
      draft: true,
      body: [
        "Draft criado pelo broker confiavel apos validacao isolada.",
        "",
        `Task: ${taskId}`,
        `Head SHA: ${result.sha}`,
        `CI: ${runUrl}`,
        "",
        "Nenhum merge ou deploy foi executado.",
      ].join("\n"),
    }),
  });
  drafts += 1;
}

console.log(
  `reported=${reported} check_runs=${checks} draft_prs_created=${drafts}`,
);
