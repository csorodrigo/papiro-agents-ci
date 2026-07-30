# Papiro Agents CI

Trusted control repository for validating `agent/ops-<task-id>` branches from
`csorodrigo/lucrando-ai` and `csorodrigo/papiro`.

The source checkout job receives only one repository-specific read-only deploy
key. That key is deleted before dependencies or repository code run. The
write-capable broker token exists only in separate discovery/report jobs that
never checkout or execute source-repository code.

Successful validation publishes the `hermes-agent-ci` commit status and creates
a draft pull request if one does not already exist. Failed validation publishes
a failure status and does not create a pull request. No workflow merges or
deploys.

