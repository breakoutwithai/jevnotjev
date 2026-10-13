# Download sources

| Download | Source files | Public-safety edit |
|---|---|---|
| `jev-or-not/SKILL.md` | `skills/jev-not-jev/SKILL.md` (operator's skill library, not in this repo); `docs/api.md`; `docs/product/use-cases/when-not-to-use-jev.md` | Kept only the basic decision test, marks, type rules, and answer format. Removed private workflows, paths, names, examples, and community material. |
| `prompts.md` | `docs/api.md`; `docs/GUIDE.md`; `src/decide/jev.ts`; `src/backstage/providers.ts` | Wrote new synthetic examples. Removed live case text and all credentials. The direct Jev body guide follows the source code's request builder. |
| `requests/choice.json` | `docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md`; `examples/uc13-shop-bot/fixtures/uc13.jev.json`; `src/backstage/providers.ts` | Retained the request shape, replaced the live run's state and criteria with synthetic support text, and omitted credentials and response data. |
| `requests/noul.json` | `docs/api.md`; `src/decide/jev.ts` | Wrote a minimal synthetic, unrun body. Omitted credentials and response data. |
| `requests/score.json` | `docs/api.md`; `src/decide/jev.ts` | Wrote a minimal synthetic, unrun body. Omitted credentials and response data. |

The page `index.html` describes these six files and their use. Its access path is covered by `.deploy/backstage-nginx.conf` and `src/backstage/server.ts`.
