# Measurement validation (E9)

This is the procedure for E9: showing that the harness's timings are accurate (story #47, NFR-2) and that each kind of failed request is caught (story #48, UC-4, NFR-3). It follows the Test Plan's cases, TC-NFR2-01, TC-NFR2-02, TC-UC4-01 to TC-UC4-11, TC-NFR3-01 and TC-NFR3-02, and adds the tools and the details the Test Plan leaves out.

Run it on the reference machine with the installed harness, in the system-test session before the official runs. It takes about an hour. Everything it saves is test data: export it, then clear the harness's data folder before the first official run, as the Test Plan says (section 2.2).

## Before you start

- Set the machine up as the Test Plan's section 2.1 lists: mains power, the usual power mode, the usual network, other applications closed, Windows Update paused.
- Start the Oracle as [run-the-oracle.md](run-the-oracle.md) describes, and ask it one warm-up question in its own page.
- Install the newest MSI and start the harness.
- Open PowerShell in the repository's `harness` folder. Parts 1 and 2 run the scripts from there, and Part 1's report needs Node, which the Oracle's frontend already uses.

## Part 1. Timing overhead and CPU use (#47)

The harness times an Oracle trial from browser events: begin is when the POST to `/api/search` leaves the page, and first response is when its response arrives. Chromium's developer tools time the same request on their own. TC-NFR2-01 compares the two; TC-NFR2-02 logs the CPU the harness uses while it does so.

1. **Start a fresh session.** Close and reopen the harness, so the export holds only these trials.
2. **Start the CPU logger** in its own PowerShell window and leave it running:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\log-cpu.ps1
   ```

   It prints the file it writes to (`cpu-log-<date>-<time>.csv`). If it warns that no harness process is running, start the harness first. Every second it records the CPU used by the harness's own processes, by the Chromium window that shows the Oracle, and by Ollama, each as a share of the whole machine. Only the harness's share counts toward NFR-2.
3. **Open the Oracle window.** Run one Oracle trial with question 1. It is a warm-up and is not counted.
4. **Open the developer tools in that window.** Click into the Oracle's page and press F12. Choose the **Network** tab, tick **Preserve log** (each trial reloads the chat page, which would otherwise clear the list), and type `api/search` in the filter box.
5. **Run the twelve trials.** Run one Oracle trial for each of questions 1 to 12. After each one, in the developer tools, click the `search` row whose method is **POST** (ignore the OPTIONS row before it, which is the browser's preflight). Read the total time on its **Timing** tab. In a file named `devtools.csv`, write the trial's Test # (from "This session" on the Test Console) and that time in milliseconds:

   ```csv
   Test #,DevTools ms
   2,7884
   3,5120
   ```

   The developer tools show "7.88 s" as 7880 ms. Their figure includes the response's download, and the harness's stops at the response's arrival. The difference is a few milliseconds, because `/api/search` answers with a single JSON reply.
6. **Stop the CPU logger** with Ctrl+C in its window, right after the last trial.
7. **Export the session as CSV** from the Export tab. Choose the current session and **All subjects**. Two files are written: the log and its `-supplementary.csv`.
8. **Work out the results:**

   ```powershell
   node scripts\nfr2-report.mjs --log C:\path\to\TestLog-2026-11-28.csv --devtools devtools.csv --cpu cpu-log-20261128-140501.csv
   ```

   It prints two Markdown tables:
   - **TC-NFR2-01:** every trial's two times and their difference, and the median difference without sign. That median must be 50 ms or less.
   - **TC-NFR2-02:** the average CPU use of each group over the samples taken during the twelve trials, from begin to end. The harness's average must be 10% or less.

   The report says PASS or FAIL for each and lists any trial it could not compare.
9. **Keep the evidence.** Copy the export, `devtools.csv`, the CPU log, and the printed report to the project OneDrive folder. Then fill in the Test Plan's execution record (Table 12) with the median difference and the average CPU use.

The CPU logger does the work of the Performance Monitor step in TC-NFR2-02. It uses the same source: the processor time Windows keeps for each process, divided by the elapsed time and the number of logical processors. To cross-check, add the counter `Process(DOE Oracle Test Harness*)\% Processor Time` in Performance Monitor. That counter is per core, so divide it by the number of logical processors.

## Part 2. Failure cases (#48)

The Oracle is never modified, so each failure is produced from outside it, as the Test Plan's section 2.4.4 says. Put everything back after each case. For every case, write down its Test #, the failure type shown, and the elapsed time. For TC-NFR3-02, also use a stopwatch to time how long Start Trial takes to come back.

| # | Test Plan | Do this | Expected |
| --- | --- | --- | --- |
| 1 | TC-UC4-01, TC-NFR3-02 | Press Ctrl+C in the backend's window (Window 2 in [run-the-oracle.md](run-the-oracle.md)). Leave the frontend running. Run an Oracle trial. Then start the backend again. | Failed, UNREACHABLE, with an error message and the elapsed time. Start Trial is back within 5 seconds. |
| 2 | TC-UC4-08 | Ask the Oracle its warm-up question, then run the same question again. | A new trial with a new Test # is saved as Success. The failed trial is still listed. |
| 3 | TC-UC4-02 | Press Ctrl+C in both the backend's and the frontend's windows. Run an Oracle trial. Then start both again. | Failed, UNREACHABLE. |
| 4 | TC-UC4-03 | Right-click Ollama's tray icon and choose Quit, leaving the backend and frontend running. Run an Oracle trial. Then start Ollama from the Start menu. | Failed, never Success. Write down which type it was: ERROR_RESPONSE if the backend answered with an error status, UNREACHABLE if it did not answer. |
| 5 | TC-UC4-04, TC-NFR3-01, TC-NFR3-02 | Open Resource Monitor (`resmon`), go to the CPU tab, and right-click each process whose name starts with `ollama`, choosing Suspend Process. Start an Oracle trial and wait a little over a minute. Then resume each process the same way. | Sixty seconds after the trial started, it is saved as Failed with the type TIMEOUT. The elapsed time is between 60,000 and 61,000 ms. Start Trial is back within 5 seconds. |
| 6 | TC-UC4-05 | Turn off Wi-Fi, or unplug the network cable. Run a Copilot trial and a Google trial. Then reconnect. | Each trial is saved as Failed with the type UNREACHABLE. |
| 7 | TC-UC4-09 | Run question 12 against the Oracle. | Saved as Success with whatever the Oracle answered, a refusal included. No failure. |
| 8 | TC-UC4-11 | Export the session and read the rows of cases 1 and 5. | Each failed trial has a row with the timestamps it reached and an empty answer. Its Supplementary row shows the failure type. |

Two failure types cannot be produced on demand with the live subjects: an error response (TC-UC4-06) and an empty answer (TC-UC4-07). The automated tests in Part 3 produce them against saved copies of the subjects' pages. If either one appears during a session, write it down with its Test #.

## Part 3. Automated checks (#49)

These run on every pull request, on Ubuntu and on Windows (`.github/workflows/harness-ci.yml`), and must pass before a merge.

| What | Where | Test Plan |
| --- | --- | --- |
| Duration math in whole milliseconds; ISO 8601 UTC timestamps with milliseconds | `src/main/execution/timing-service.test.ts` | TC-UC2-02, TC-NFR4-01 |
| Each failure classification, and the order when signals combine (Table 15) | `src/main/execution/failure-detector.test.ts` | TC-UC4-06, TC-UC4-07, TC-UC4-10 |
| An HTTP 500, an empty answer, a refused connection, the frontend down, and a refusal that is an answer, against a saved copy of the Oracle's chat page | `src/main/adapters/oracle-adapter.test.ts` | TC-UC4-01, TC-UC4-02, TC-UC4-06, TC-UC4-07, TC-UC4-09 |
| The 60-second timer, and the harness being ready for the next trial | `src/main/execution/trial-controller.test.ts` | TC-UC4-04, TC-NFR3-01, TC-NFR3-02 |
| The NFR-2 report's arithmetic | `scripts/nfr2-report.test.mjs` | TC-NFR2-01, TC-NFR2-02 |

Run them all with `npm test`.
