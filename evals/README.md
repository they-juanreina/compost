# evals

Three eval surfaces, all stored locally in `.compost/evals.sqlite`:

1. **Skill evals** — golden-set examples per skill in `golden/<skill>/`. Score coverage, faithfulness, schema conformance. CI-friendly.
2. **AI-suggestion evals** — live, per-event LLM-as-judge runs from the eval-grader loop.
3. **End-to-end harness evals** — "complete seed" fixtures; gates major releases.

See [ROADMAP.md § Evals](../ROADMAP.md#evals).
