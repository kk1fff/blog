# Backlog

## Streamline publish process

Status: planned

Build an article management system through the Content and Preview MCPs, with
a deterministic process for creating articles, staging previews, reviewing
revisions, publishing, and updating previously published articles.

The current preview build excludes drafts, requiring the agent to temporarily
change an article's draft status to preview it. Replace this workaround with
an explicit staging operation and a documented article lifecycle.

### Intended workflow

1. Create or revise an article through the Content MCP.
2. Stage a specific article revision and its assets for preview.
3. Render and inspect that staged revision through the Preview MCP on desktop
   and phone; return the preview location and revision identifier.
4. Present that revision for human review. Feedback creates a new revision and
   repeats staging and preview.
5. Publish the reviewed revision after explicit approval, using the configured
   delivery policy.
6. For later updates, retrieve the article, revise it, and repeat the same
   staging, preview, review, and publishing process.

### Acceptance criteria

- MCP operations expose article identity, revision, and lifecycle status so
  agents can reliably determine the next step and resume interrupted work.
- Draft previews do not require changing production eligibility or publishing
  unrelated drafts. Staging does not push or deploy production content.
- Preview and publication refer to the same article revision and asset set;
  changes after review require a new preview and approval.
- Updating a published article preserves its identity and URL, and keeps the
  live version available while the next revision is being prepared.
- Publishing selects the reviewed article and its required assets, without
  accidentally including unrelated pending work.
- Repeated staging or retrying a failed operation is safe and produces a clear
  result; failures expose enough state for the agent to recover.
- The content skill documents the MCP workflow and removes the temporary
  draft-status preview workaround.
- Verify the lifecycle for a new article and an update to a published article,
  including revision after feedback and recovery from an interrupted operation.
