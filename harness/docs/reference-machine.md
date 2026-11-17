# The reference machine

Every official test run happens on one Windows 11 machine, so that results can be compared and reproduced (story #45, NFR-5). This document records what that machine is and what must stay the same from run to run.

Nothing here is filled in yet. The Tester fills it in on the machine itself. Do not copy values from another machine or from memory.

## Specification

Record it once the machine is set up ([run-the-oracle.md](run-the-oracle.md)) and the harness is installed, with Ollama running. Record it again whenever anything in it changes: a Windows update, a new Ollama version, a re-created model, a new harness version.

### How to fill this in

1. Open PowerShell in the repository's `harness` folder.
2. Run the script. It only reads, changes nothing, and contacts no outside site (its one network call is to Ollama on this machine):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\reference-machine-spec.ps1 | Set-Clipboard
   ```

3. Paste over the table below. Check each row against Settings, System, About, as Tom suggested, and fix anything the script got wrong.
4. Fill in by hand any row that says "not found" or "fill in by hand". For internet speed, run one speed test in a browser and write down the download and upload figures and the time of day.
5. Write the date and your name under the table.

### The table

| Item | Value |
| --- | --- |
| Model | |
| CPU | |
| RAM | |
| GPU | |
| Storage | |
| Free space on the system drive | |
| Display | |
| Display scale | |
| Windows edition | |
| Windows version and build | |
| Power source | |
| Power plan | |
| Network type and link speed | |
| Internet speed (download / upload, Mbps) | |
| Ollama version | |
| Ollama model tags | |
| Ollama models loaded now (and on CPU or GPU) | |
| Python (on PATH) | |
| Python (the Oracle's venv) | |
| Node | |
| ffmpeg | |
| Git commit of the Oracle checkout | |
| Harness version | |
| Harness browser | |

Recorded on: ____ by: ____

What the rows mean, where it is not obvious:

- **Ollama model tags** lists every model with its size, quantization, and the start of its ID. The ID changes if a model is pulled again or `CombinatorialExpert` is re-created, which can change answers and timings. Three models matter: `CombinatorialExpert`, the `llama3.2` it was built from, and `nomic-embed-text`.
- **Ollama models loaded now** shows whether a loaded model runs on the CPU or the GPU. Ask the Oracle one question first so the model is loaded, or the row reads "none loaded".
- **Harness browser** is the Chromium inside the installed harness. It changes only with the harness version.
- **Git commit of the Oracle checkout** is the commit of this repository on the machine. The Oracle's code is at its root.

## Is 16 GB of RAM enough?

Story #45 asks whether 16 GB is enough with the Oracle, the harness, and the browser running together. This has not been measured yet. To measure it:

1. Start the Oracle and ask the warm-up question ([run-the-oracle.md](run-the-oracle.md)).
2. Start the harness, open Copilot and sign in, and run one Oracle trial and one Copilot trial, so that both Chromium windows are open.
3. With everything still open, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\reference-machine-spec.ps1 -MemorySnapshot
   ```

4. Paste the output below.
5. Open Task Manager, Performance, Memory, and note "In use" and "Committed" as a cross-check.

| Item | Value |
| --- | --- |
| RAM usable | |
| RAM in use | |
| RAM available | |
| Ollama | |
| Python (Oracle backend) | |
| Node (Oracle frontend) | |
| Harness | |
| Chromium (harness browser) | |
| Task Manager "In use" / "Committed" | |

Conclusion (enough, or not, and why): ____

A rule of thumb for reading it: if "RAM available" is under about 1 GB, or Task Manager's "Committed" is above the installed RAM, Windows is paging and timings from this machine are not steady. Say so in the conclusion.

## Conditions to hold steady for official runs

Timings are only comparable when the machine is in the same state each time. Check this list before every official session and note anything that differed in the session's record.

### Power and heat

- Plugged in to mains power, not on battery. On battery, Windows may limit the CPU's speed.
- The same power mode every time (Settings, System, Power & battery, Power mode). Record which one in the table's "Power plan" row.
- Battery saver and Energy saver off.
- On a hard, flat surface with the vents clear. A laptop on a bed or in a bag overheats and slows down.
- Sleep and screen-off timers long enough that the machine does not sleep in the middle of a session.

### Network

- The same network every time, and the same kind of connection (wired, or the same Wi-Fi access point at similar signal strength).
- No VPN, unless every run uses the same one.
- No large downloads, cloud sync, or video calls on the machine or, as far as you can tell, on the network.
- The Oracle runs on the machine itself, so the network does not affect its timings. It does affect Copilot and Google, whose answers come from the internet, and those services are also faster or slower at different times of day. Note the time of each session.

### Other software

- Close every other app: browsers, Teams, Slack, OneDrive, IDEs, Docker. Only the Oracle's three terminals, the harness, and the windows it opens should be running.
- Pause Windows Update for the session, and do not start a session while an update is downloading or a restart is pending.
- Do not run while a Microsoft Defender scan is in progress. A scan competes with the Oracle for the CPU and the disk.
- Nothing else may be using port 5173 or port 5000 (see [run-the-oracle.md](run-the-oracle.md)).
- No other program should be using Ollama.

### The Oracle

- The same commit of this repository. Record it in the table.
- The same Ollama version and the same three models with the same IDs. Do not run `ollama pull` or re-create `CombinatorialExpert` between sessions that must be compared.
- The backend started without `--debug`.
- **The model is warm.** The first answer after Ollama loads the model takes much longer than the rest (about 22 seconds against about 3 on the development Mac). Ask the warm-up question before any timed trial; it is not counted.
- **Ollama unloads a model that has been idle for 5 minutes**, unless its keep-alive setting was changed. After any pause of 5 minutes or more, ask the warm-up question again before the next timed trial. `ollama ps` shows when each loaded model will be unloaded (check on the reference machine). Do not change this setting between sessions.
- Ollama uses the GPU if it finds one it supports, the CPU otherwise. Which one it used is in the "Ollama models loaded now" row. If that row changes between sessions (for example after a driver update), the timings are not comparable.
- `rag_system.py` asks Ollama for 8 CPU threads whatever the machine has. On a CPU with fewer than 8 logical processors this can slow answers down. Record the logical processor count; the "CPU" row has it.
- The vector store (`instance/vector_store`) is built once, the first time the backend starts, and reused after that. Do not delete it between sessions: rebuilding it takes time and is one more thing that could differ between runs.
- Restart the backend at the start of each session, so its memory use starts from the same point.

### The harness

- The same harness version for every session that must be compared. The version is in the window under "App info" and is saved with every session.
- The bundled browser comes with the harness version, so it is the same whenever the version is.
- The same display and the same scale. Page layout, and so page timing, depends on the window size.
- The same Copilot product and account type. The default is Microsoft 365 Copilot Chat with a work or school account.
- Leave the Chromium windows visible and do not minimize them during a trial, so every trial runs with its window in the same state.
- Do not use the machine for anything else while a trial runs.

### Starting a session the same way

1. Restart Windows, sign in, and wait a few minutes for start-up tasks to finish.
2. Check the list above.
3. Start the Oracle and ask the warm-up question ([run-the-oracle.md](run-the-oracle.md)).
4. Start the harness and run the session.
