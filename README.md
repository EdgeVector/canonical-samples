# canonical-samples

Retained sample records generated against the May 2026 schema registry.

The old `/v1/snapshot` service route is retired. The manifest records the
historical schema identities; it does not establish that those definitions
are published by today's Schema Service.

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
- `tools/validate-format.py` — checks JSON syntax, duplicate fields, manifest
  identities, record counts and complete sample-file membership.
- `.github/workflows/ci.yml` — requires that format check on PRs, main pushes,
  merge groups and manual runs, without a service credential or a skipped
  validation step.
- `tools/generate.ts` and `tools/validate.ts` — historical tools for the retired
  snapshot API. They are not the current CI procedure.

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

## Validation

```bash
python3 tools/validate-format.py
```

This checks the retained data and manifest. Current live schema type validation
requires current published definitions and is not claimed by this check.

## Historical generation

Regeneration is on-demand. There is no cron, no webhook, no auto-update.
The retained generator targets the retired snapshot API. A future regeneration
must first bind its inputs to current published schema definitions and update
the generator. Keep this corpus unchanged until that work is accepted.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution flow.

## License

Apache-2.0. See [LICENSE](LICENSE).
