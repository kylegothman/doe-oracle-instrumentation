# DOE Oracle Instrumentation

SE 4485 Team 3 capstone. We are building the DOE Oracle Test Harness, a Windows 11 desktop app that measures the DOE Oracle, Microsoft Copilot, and Google Search by asking each one the same 12 questions.

## Repository layout

- Repository root (`doe/`, `doe-frontend/`, `instance/`, `rag_system.py`, `requirements.txt`, and the other files that were here first): the sponsor's DOE Oracle code. It is the system being measured. Do not modify, move, reformat, or delete any of it, and do not try to improve or change how the Oracle works.
- `harness/`: the test harness. All harness code goes here. See `harness/README.md` for setup and scripts.

## Working on the harness

- Run every command from `harness/`: `npm install`, `npm run dev`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Use the Node version in `harness/.nvmrc`.
- Run lint, typecheck, test, and build locally before opening a pull request. If something fails and you cannot fix it, stop and say so instead of working around it.
- Never commit secrets, `.env` files, build output, or database files.

## Branches and pull requests

- `main` is protected: one approving review, all review threads resolved, no direct pushes.
- One branch per story, named `e<N>/<short-name>` (for example `e0/scaffold`). When a story depends on an unmerged one, branch from that branch, set it as the PR base, and say in the description which PR must merge first.
- Every PR description references the epic issue and the matching story issue, and ends with a short testing section.
- Keep each PR small and focused on one story. Do not pull in features from later epics.
