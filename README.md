# canonical-samples

LLM-generated sample rows for the FoldDB canonical schema registry.

This repo is the **data backbone** that `folddb-dev new --from-prod`
fetches from when scaffolding a new fold node project. It carries:

- One file per canonical schema at `samples/<descriptive_name>.json`,
  each a JSON array of plausible rows whose keys + value types match
  the schema's `field_types` from the live schema_service snapshot.
- A `manifest.json` that records what was generated, when, by which
  model, and against which snapshot.
- `tools/generate.ts` — Bun script that fetches the schema_service
  snapshot, drives an LLM to author rows per schema, validates each
  row's shape against `field_types`, and writes both the per-schema
  file and the manifest.
- `tools/validate.ts` — pure shape validator. Reused by CI and by the
  generator's post-generation check. Type-only — not a semantic
  validator.
- `.github/workflows/ci.yml` — runs `tools/validate.ts` on every PR.

The samples are LLM-generated and contain **no real user data**. They
exist so a developer running `folddb-dev new --from-prod` gets a
project pre-seeded with plausible rows for the schemas it imports.

## Consuming the samples

```bash
# Direct read — the URL is stable
curl -sSL https://raw.githubusercontent.com/EdgeVector/canonical-samples/main/samples/Message.json | jq .

# Or check out the repo
git clone https://github.com/EdgeVector/canonical-samples.git
cat canonical-samples/samples/Recipe.json
```

The downstream consumer (`folddb-dev new --from-prod`) reads
`manifest.json` to learn which schemas are covered and what
`identity_hash` each sample file was generated against — so it can
warn if a schema has drifted since the corpus was last regenerated.

## Coverage

v1 ships ~20 well-known canonical schemas. The schema_service registry
has ~956 schemas total; broadening coverage is on-demand and lives in
follow-up PRs. Run `bun tools/generate.ts --help` to see the
`--schemas <list>` and `--all` flags.

## Regenerating

Regeneration is on-demand. There is no cron, no webhook, no auto-update.
A human runs `bun tools/generate.ts` and opens a PR.

```bash
cd tools && bun install
EXEMEM_DEV_API_KEY=em_... \
ANTHROPIC_API_KEY=sk-... \
  bun generate.ts --schemas Message,Recipe,Book   # subset
# or
  bun generate.ts --all                            # everything
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution flow.

## License

Apache-2.0. See [LICENSE](LICENSE).
