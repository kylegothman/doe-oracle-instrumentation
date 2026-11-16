# Running the DOE Oracle on the reference machine

Step by step, from a fresh clone on Windows 11 to an Oracle the harness can reach (story #46). Any teammate should be able to follow this without having seen the Oracle before.

The Oracle is the sponsor's system and the thing being measured. Nothing here changes its code. If a step seems to need a change to a file outside `harness/`, stop and ask.

## Read this first

- **These steps were worked out from the Oracle's code on macOS, not run on Windows.** Every step that has not been confirmed on Windows 11 is marked **(check on the reference machine)**. The first person to follow this on the reference machine should confirm or correct each mark and open a pull request with the fixes.
- The root `README.md` was written for macOS and for an earlier version. Where it and the code disagree, this document follows the code and says so under "Where the root README differs".
- Commands are for **PowerShell**, run from the repository's root folder unless a step says otherwise. Keep each of the three long-running programs (Ollama, the backend, the frontend) going while you test.

## What you are setting up

The Oracle is three programs on the same machine:

| Program | What it does | Address |
| --- | --- | --- |
| Ollama | runs the language model and the embedding model | `http://127.0.0.1:11434` |
| Backend (Flask, Python) | finds passages in the research papers and asks Ollama for the answer | `http://127.0.0.1:5000` |
| Frontend (Vite, Node) | the chat page the harness drives | `http://localhost:5173/chat` |

The harness opens the frontend's chat page in its own browser, types a question, and times the answer. It never talks to the backend or Ollama itself.

Two addresses are fixed by the Oracle's code:

- The frontend calls the backend at `http://127.0.0.1:5000` unless told otherwise (`doe-frontend/src/pages/Chat.tsx`). That is Flask's default, so on Windows nothing needs to be configured.
- The backend only accepts requests from a page served on port **5173** (`doe/__init__.py`, the CORS rule). If the frontend ends up on any other port, every question fails with "Error searching for ...".

## One-time setup

You need about 10 GB of free disk space and an internet connection for the downloads.

### 1. Install Git, Python, and Node

1. Git: https://git-scm.com/download/win
2. Python **3.12**, 64-bit: https://www.python.org/downloads/windows/ . Tick "Add python.exe to PATH" in the installer. 3.12 is the version the Oracle runs on today on the development Mac; a newer one may not have every package yet. **(check on the reference machine)**
3. Node.js LTS: https://nodejs.org . The harness's own development uses the version in `harness/.nvmrc`; the Oracle's frontend needs Node 18 or later. **(check on the reference machine)**

Open a new PowerShell window and check all three:

```powershell
git --version
python --version
node --version
```

If `python --version` opens the Microsoft Store or prints nothing, Python is not on PATH: run its installer again and tick the PATH box. **(check on the reference machine)**

### 2. Clone the repository

```powershell
git clone https://github.com/kylegothman/doe-oracle-instrumentation.git
cd doe-oracle-instrumentation
```

The Oracle's code is at the root of this repository; the harness is in `harness/`. All the commands below assume you are in the repository's root folder.

### 3. Install Ollama

1. Download and run the Windows installer from https://ollama.com/download .
2. Ollama then runs in the background (an icon in the system tray) and starts again each time you sign in. **(check on the reference machine)**

Check it:

```powershell
ollama --version
Invoke-RestMethod http://127.0.0.1:11434/api/version
```

Both should print a version. If the second fails, start Ollama from the Start menu.

### 4. Download the models

```powershell
ollama pull llama3.2
ollama pull nomic-embed-text
```

`llama3.2` is the base language model (about 2 GB) and `nomic-embed-text` (about 270 MB) is the model that turns text into vectors for the search. `rag_system.py` uses `nomic-embed-text` by exactly that name.

### 5. Create the CombinatorialExpert model

The backend asks Ollama for a model called `CombinatorialExpert` (`doe/__init__.py`). It is `llama3.2` with the Oracle's system prompt, built from `instance/knowledge/CombinatorialExpert_Modelfile`:

```powershell
ollama create CombinatorialExpert -f instance\knowledge\CombinatorialExpert_Modelfile
ollama list
```

`ollama list` should now show three models: `CombinatorialExpert`, `llama3.2`, and `nomic-embed-text`. **(check on the reference machine)**

This is the same command the sponsor's `setup_combinatorial_model.py` runs. You can run that script instead (`python setup_combinatorial_model.py`); it also checks that the two base models are there.

> **Which Modelfile.** There are two in the repository, and they are not the same model:
>
> | File | Base model | Used by |
> | --- | --- | --- |
> | `instance/knowledge/CombinatorialExpert_Modelfile` | `llama3.2` (the default tag, the 3-billion-parameter model) | `setup_combinatorial_model.py` |
> | `CombinatorialExpert.Modelfile` (repository root) | `llama3.2:1b` (the smaller 1-billion-parameter model), with a different system prompt | nothing in the code |
>
> This document uses the first, because it is the one the code builds. The root file would give a smaller, faster model and different answers, so the two must not be mixed between runs.
>
> The development Mac, where every timing so far was taken, uses the first as well. Checked on 2026-11-16: its `CombinatorialExpert` has the first file's system prompt, and its model data is the same 2.0 GB file as `llama3.2` (ID starting `dde5aa3fc5ff`). What the sponsor's own machine runs has not been checked.
>
> To confirm yours matches, after creating it:
>
> - `ollama list` shows `CombinatorialExpert` and `llama3.2` at the same size, about 2.0 GB. A size near 1.3 GB means it was built from `llama3.2:1b`.
> - `ollama show CombinatorialExpert --modelfile` prints a `SYSTEM` text that starts "You are Dr. Wong's Combinatorial Testing Research Expert". If it starts "You are the DOE Oracle", the model was built from the root file: remove it with `ollama rm CombinatorialExpert` and create it again as above.
>
> **(check on the reference machine)**, and record the result in [reference-machine.md](reference-machine.md).

### 6. Set up the Python environment

Create a virtual environment in the repository root and install the packages:

```powershell
python -m venv venv
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install -r requirements.txt
venv\Scripts\python.exe -m pip install openai-whisper torch
```

The last line is required, not optional: `doe/__init__.py` imports `whisper` and loads its model as the backend starts, so the backend will not start without `openai-whisper` and `torch`, and `requirements.txt` does not list them. It is a large download (PyTorch is several hundred megabytes). **(check on the reference machine)**

These commands call the environment's own `python.exe` directly, so you never need to "activate" it. That avoids PowerShell's script execution policy, which blocks `venv\Scripts\Activate.ps1` on many machines.

If the backend later stops with `ModuleNotFoundError`, install the module it names the same way, for example:

```powershell
venv\Scripts\python.exe -m pip install langchain-text-splitters
```

`rag_system.py` imports `langchain_text_splitters`, which `requirements.txt` does not list by name; it normally arrives with `langchain`. **(check on the reference machine)**

For reference, the versions in the working environment on the development Mac (Python 3.12.2) are: Flask 3.1.3, flask-cors 6.0.5, langchain 1.4.0, langchain-community 0.4.2, langchain-core 1.6.2, langchain-chroma 1.1.0, langchain-ollama 1.1.0, langchain-text-splitters 1.1.2, chromadb 1.5.9, pypdf 6.18.0, pdfplumber 0.11.10, openai-whisper 20250625, torch 2.14.0. `requirements.txt` only sets minimum versions, so a fresh install may get newer ones. If something breaks after a fresh install, compare against this list.

### 7. Install ffmpeg

```powershell
winget install Gyan.FFmpeg
```

Then open a **new** PowerShell window and check `ffmpeg -version` prints a version. **(check on the reference machine)**

ffmpeg is used by the Oracle's voice features: speech-to-text (`/api/stt`) and the avatar's speech (`/api/tts`). A typed question, which is all the harness sends, does not use it. Install it anyway so the Oracle on the reference machine is complete.

### 8. Install the frontend's packages

```powershell
cd doe-frontend
npm install
cd ..
```

The root README also says to run `npm install lottie-react`. That is no longer needed: it is already in `doe-frontend/package.json`.

### 9. The avatar (optional, not needed for timing)

The chat page has a talking avatar from a service called Simli. It needs two keys. **Timing does not need the avatar**, and without the keys the chat page still works: the avatar area shows "Missing VITE_SIMLI_API_KEY or VITE_SIMLI_FACE_ID in doe-frontend/.env" and questions are answered as usual.

If the team decides to run with the avatar, create the file `doe-frontend\.env` with these two lines, with the values the sponsor's team gives you:

```
VITE_SIMLI_API_KEY=
VITE_SIMLI_FACE_ID=
```

- This file is never committed. Git already ignores it (`.env` is in both `.gitignore` and `doe-frontend/.gitignore`). Do not paste the keys into an issue, a pull request, a chat, or this document.
- Restart the frontend after creating or changing the file.
- With the keys, the page connects to Simli over the internet and, after each answer, asks the backend to speak it. On Windows that speech step also needs the `pyttsx3` Python package (`venv\Scripts\python.exe -m pip install pyttsx3`), which `requirements.txt` does not list. **(check on the reference machine)**
- Decide once whether official runs have the avatar or not, and keep it that way: it is one of the conditions in [reference-machine.md](reference-machine.md).

The same file can hold `VITE_API_URL=` to point the frontend at a backend that is not on `http://127.0.0.1:5000`. On Windows you should not need it.

## Starting the Oracle (every session)

Use three PowerShell windows, all in the repository's root folder. Start them in this order.

### Window 1: Ollama

Ollama is normally already running in the background. Check:

```powershell
ollama list
```

It should list the three models. If it reports that it could not connect, start Ollama from the Start menu, or run `ollama serve` in this window and leave it open.

### Window 2: the backend

```powershell
venv\Scripts\python.exe -m flask --app doe run
```

- Run it from the repository's root folder. The backend finds `rag_system.py` and its vector store relative to the folder it was started in.
- Do not add `--debug`, although the root README does. Debug mode loads everything twice and restarts the backend when files change, which is wrong for timing.
- **The first start takes several minutes.** It downloads Whisper's "base" model (about 140 MB, once) and builds the vector store from the three research papers in `instance/research_papers`, printing "Vector store not found, loading papers..." and then "Papers loaded successfully." Later starts print "Loading existing vector store..." and take a few seconds. **(check on the reference machine)**
- It is ready when it prints `Running on http://127.0.0.1:5000`.
- If Windows Firewall asks whether to allow Python, allowing private networks is enough; the harness only uses this machine. **(check on the reference machine)**

### Window 3: the frontend

```powershell
cd doe-frontend
npx vite --port 5173 --strictPort
```

- It is ready when it prints `Local: http://localhost:5173/`.
- `--strictPort` makes it stop with an error if port 5173 is taken, instead of quietly moving to 5174, where the backend would reject every question. If it stops, find what is using the port (`Get-NetTCPConnection -LocalPort 5173 -State Listen`), close that program, and start the frontend again.
- This is the same dev server `npm run dev` starts. `npx vite` is used here because PowerShell does not reliably pass `--port` and `--strictPort` through `npm run dev --`. **(check on the reference machine)**

## Check the Oracle is healthy

Do all four before a session. They take a minute.

1. **The three programs are listening.**

   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 11434, 5000, 5173 | Select-Object LocalAddress, LocalPort
   ```

   All three ports should be listed. **(check on the reference machine)**

2. **The models are there.** `ollama list` shows `CombinatorialExpert`, `llama3.2`, and `nomic-embed-text`.

3. **The backend answers.** This sends one question straight to the backend:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5000/api/search -ContentType 'application/json' -Body '{"query":"What is combinatorial testing?"}'
   ```

   It should print a `summary` (the answer) and `results` (the source passage). The first call after Ollama starts is slow: see the warm-up below. Opening `http://127.0.0.1:5000/` in a browser shows "Not Found"; that is normal, because the built frontend it would serve does not exist.

4. **The chat page answers.** Open `http://localhost:5173/chat` in any browser, type a question, and press Enter. An answer with a source line under it means the whole chain works. "Error searching for ... Failed to fetch" means the backend is not running or the frontend is not on port 5173.

## Warm up before any timed trial

The first answer after Ollama loads the model is much slower than the rest, because the model is being read into memory: about 22 seconds against about 3 on the development Mac. That first answer is **not counted**.

1. After the health check, ask one question on the chat page (step 4 above does this), or run one Oracle trial in the harness and disregard it.
2. Wait for the answer.
3. Then start the timed trials.

Ollama unloads a model that has been idle for 5 minutes. **After any pause of 5 minutes or more, warm up again** before the next timed trial. `ollama ps` shows which models are loaded and until when. **(check on the reference machine)**

The harness gives a trial 60 seconds. If a trial fails with TIMEOUT right after a pause, the model was cold: warm up and run it again.

## Point the harness at the Oracle

**The default needs no setup.** An installed harness looks for the Oracle at `http://localhost:5173` and opens its chat page, `http://localhost:5173/chat`. If you followed the steps above on the same machine, start the harness, choose **DOE Oracle**, and run a trial.

To make an installed harness use a different address, set the `HARNESS_ORACLE_URL` environment variable for your Windows user, then close and reopen the harness:

```powershell
[Environment]::SetEnvironmentVariable('HARNESS_ORACLE_URL', 'http://127.0.0.1:5173', 'User')
```

To go back to the default, remove it and reopen the harness:

```powershell
[Environment]::SetEnvironmentVariable('HARNESS_ORACLE_URL', $null, 'User')
```

**(check on the reference machine)** that a harness started from the Start menu after this picks up the new value; if it does not, sign out of Windows and back in.

Things to know:

- Only the scheme, host, and port are used; the harness always adds `/chat`.
- Because of the backend's port rule, the only addresses that work with the Oracle on the same machine are `http://localhost:5173` (the default) and `http://127.0.0.1:5173`. Prefer the default: depending on how Windows resolves `localhost`, the dev server may not answer on `127.0.0.1`. **(check on the reference machine)**
- If the harness cannot load the page, the trial fails as UNREACHABLE with "Could not reach the DOE Oracle at ...", which shows the address it tried.
- There is no settings screen for this yet; one is planned with the UI epic (E6). A developer running `npm run dev` sets the same variable in the terminal: `$env:HARNESS_ORACLE_URL = 'http://127.0.0.1:5173'; npm run dev`.

## Stopping

Press Ctrl+C in the backend and frontend windows. Ollama can stay running; to stop it, right-click its tray icon and choose Quit.

## Where the root README differs

| Root README | What the code needs |
| --- | --- |
| `brew install ffmpeg` | macOS only. On Windows use `winget install Gyan.FFmpeg` (step 7). |
| `pip install flask flask-cors openai-whisper torch` as an extra | `flask` and `flask-cors` are already in `requirements.txt`. `openai-whisper` and `torch` are not, and the backend does not start without them (step 6). |
| Never says to create `CombinatorialExpert`, except under Troubleshooting | The backend cannot answer without it (step 5). |
| `ollama pull llama3.2`, with a root `CombinatorialExpert.Modelfile` that says `llama3.2:1b` | The model the code builds comes from `instance/knowledge/CombinatorialExpert_Modelfile`, which uses `llama3.2`. Nothing uses the root Modelfile (step 5). |
| `flask --app doe run --debug` | Leave out `--debug` for timing (window 2). |
| `npm install lottie-react` | Already in `doe-frontend/package.json` (step 8). |
| `npm run dev` | Works, but can move to another port without saying so. Use `npx vite --port 5173 --strictPort` (window 3). |
| Clone `ShreyaaArun/DOE-LLM-App-Fall2025` | Clone this repository, which contains that code plus the harness (step 2). |
| "Python 3.8+" | Use Python 3.12 (step 1). |
| The temperature in the Modelfile | `rag_system.py` sets its own values on every request (temperature 0.2, at most 100 tokens, 8 threads), which take precedence over the Modelfile's. Nothing to do; it explains why answers are short. |

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| The backend stops with `ModuleNotFoundError: No module named 'whisper'` | `openai-whisper` and `torch` are not installed | Step 6, the last `pip install` line. |
| The backend stops with a connection error to port 11434 | Ollama is not running | Start Ollama, then start the backend again. |
| An answer never comes and the backend prints an error naming `CombinatorialExpert` | The model was not created | Step 5. |
| The chat page shows "Error searching for ... Failed to fetch" | The backend is not running, or the frontend is not on port 5173 | Check both windows and the port (health check 1). |
| The first backend start seems stuck after "Vector store not found, loading papers..." | It is embedding the papers | Wait; it can take several minutes the first time. |
| Every trial in the harness is UNREACHABLE | The frontend is not running, or `HARNESS_ORACLE_URL` points somewhere else | Open `http://localhost:5173/chat` in a browser; remove the variable. |
| The first trial after a pause is TIMEOUT or very slow | The model was unloaded | Warm up again. |
| `venv\Scripts\Activate.ps1 cannot be loaded because running scripts is disabled` | PowerShell's execution policy | You do not need to activate: use `venv\Scripts\python.exe -m ...` as in this document. |
