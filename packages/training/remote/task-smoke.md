Bounded smoke test (hard limit: 3 minutes). Work only in {{DIR}}.
Write `{{DIR}}/smoke.ts`, a Node 24 TypeScript script with no dependencies that reads
`{{WORK}}/data/development.json` (an array of rows `{id, features, targets, mask}`) and writes
`{{DIR}}/smoke-output.json` containing exactly:
`{"rows": <row count>, "featureLength": <length of the first row's features>,
"maskedTargetSum": <sum over all rows and j of targets[j] * mask[j]>, "firstId": <first row id>}`.
Run it once with `node smoke.ts`, confirm the file exists, then stop. Do not do anything else.
