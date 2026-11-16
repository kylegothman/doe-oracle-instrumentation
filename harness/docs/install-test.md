# Testing the installer on Windows 11

A checklist for testing a harness MSI by hand on Windows 11 (story #44). It takes about 30 minutes. Fill in the tables as you go and paste them into the pull request or the issue you were asked to test.

## What CI already checked

Every MSI you can download from a `harness-msi` run has already passed these on a clean Windows Server runner, so you do not need to repeat them:

- The MSI builds, installs silently without an error, and puts the app, `questions.json`, and the bundled Chromium in the program folder.
- The installed app starts in its self-check mode and reports that the questions file loads with all 12 questions, SQLite loads and opens a database in the per-user data folder, and the bundled Chromium launches and opens a page.
- Uninstall removes the program folder, the shortcuts, and the Apps entry, and keeps the per-user data folder.

## What is left for you

CI cannot do any of this, and it is the reason for this checklist:

- It runs Windows Server, not Windows 11, and its account is an administrator.
- It installs silently, so nobody has seen the wizard, SmartScreen, or the shortcuts work.
- It never opens the harness window.
- It cannot reach the Oracle or sign in to Copilot, so it has never run a trial.
- It never exports, and it never reinstalls over existing data.

## Before you start

You need:

- A Windows 11 machine. The reference machine is best. A machine that has never had the harness's development setup (Node, the repository, Playwright) is the real test.
- The Oracle running on that machine: follow [run-the-oracle.md](run-the-oracle.md) first, including the warm-up question.
- A work or school Microsoft account that can use Copilot Chat, for the Copilot trial.
- The MSI: on the pull request, open the `harness-msi` check, choose **Summary**, download the `doe-oracle-test-harness-msi` artifact, and extract the zip.

Fill this in first:

| | |
| --- | --- |
| Tester | |
| Date | |
| Machine (model) | |
| Windows edition, version, and OS build (Settings, System, About) | |
| MSI file name (it contains the version) | |
| Pull request or workflow run the MSI came from | |
| Signed in to Windows as an administrator or a standard user? | |
| Was the harness ever installed on this machine before? | |
| Does `%LOCALAPPDATA%\ms-playwright` exist? (It should not on a clean machine. If it does, note it; the installed app must not need it.) | |

For a first-time test, start clean: if "DOE Oracle Test Harness" is listed in Settings, Apps, Installed apps, uninstall it, and if the folder `%APPDATA%\DOE Oracle Test Harness` exists, move it somewhere else or delete it. Paste the path into File Explorer's address bar to check.

## Steps

Write **pass** or **fail** for each step. For a failure, add what you saw and a screenshot.

### 1. Install with no admin rights

1. Double-click the `.msi`.
2. If Windows SmartScreen shows "Windows protected your PC", choose **More info**, then **Run anyway**. The installer is not signed, so this is expected.
3. Go through the wizard. If it asks who to install for, choose the option for just you (the current user).
4. Finish the wizard. Leave "Run DOE Oracle Test Harness" ticked if it is offered.

Expected:

- Windows never asks for an administrator password or shows a "Do you want to allow this app to make changes" prompt.
- The install finishes without an error. It copies about 855 MB, so it can take a minute or two.
- "DOE Oracle Test Harness" is in the Start menu and on the desktop.
- The folder `%LOCALAPPDATA%\Programs\DOE Oracle Test Harness` exists and contains `DOE Oracle Test Harness.exe`.
- Settings, Apps, Installed apps lists "DOE Oracle Test Harness" with the same version as the MSI's file name.

### 2. First launch

1. Start the harness from the Start menu (or let the wizard start it).

Expected:

- The harness window opens within a few seconds.
- "App info" shows the name and the same version as the MSI's file name.
- "Storage" shows a green line saying SQLite loaded. A red "SQLite failed to load" box is a failure: copy its text.
- The bar at the top shows a session ID.
- "Saved trials" is empty on a clean machine.

### 3. One Oracle trial

The Oracle must be running and warmed up ([run-the-oracle.md](run-the-oracle.md)).

1. Under "Trial", choose **DOE Oracle** and click **Run DOE Oracle trial (Q1)**.

Expected:

- A Chromium window opens on the Oracle's chat page. It is "Google Chrome for Testing", not your own Chrome or Edge.
- The harness types "What is combinatorial testing?" and submits it, with no action from you.
- The status events go from `started` to `first response` to `completed`.
- The result shows status SUCCESS, begin, first response, and end times, a response time in milliseconds, and the start of the answer.
- The trial appears under "Saved trials".

If the result is FAILED with TIMEOUT, the model was probably cold: ask the warm-up question again, then repeat this step once. If the message says the browser that ships with the harness is missing or damaged, that is a failure of this test: copy the full message.

### 4. One Copilot trial

1. Under "Copilot sign-in", click **Open Copilot to sign in**. A second Chromium window opens.
2. Sign in there with your work or school account, including any second factor. The harness never types your password.
3. Back in the harness, click **Open Copilot to sign in** again. It should now report that Copilot is signed in.
4. Choose **Microsoft Copilot** and click **Run Microsoft Copilot trial (Q1)**.
5. When the status line says to press Enter in the Copilot window, click in the Copilot window's question box and press Enter.
6. When the answer has finished, click **Confirm** in the harness.

Expected:

- The harness types the question into Copilot but does not send it; you do.
- After **Confirm**, the result shows status SUCCESS with times and the answer, and the trial appears under "Saved trials".

If your account cannot use Copilot Chat, or the page shows a human-verification check, write that down and mark this step "not tested". Do not try to work around it.

### 5. Export

If this build has an Export screen or button (it arrives with epic E6), export the test log as an Excel workbook and as CSV, to your Documents folder.

Expected:

- A save dialog suggests `TestLog-<today>.xlsx` (or `.csv`) in Documents.
- The files are written, open in Excel, and contain one row for each trial from steps 3 and 4, with the question, the answer, and the times.

If this build has no export control yet, write "not in this build".

### 6. Check where the data went

1. Close the harness window. Both Chromium windows should close with it.
2. Open `%APPDATA%\DOE Oracle Test Harness` in File Explorer.

Expected:

- It contains `harness.db`.
- It contains `browser-profiles\copilot` (only if you did step 4).
- Nothing was written into the program folder or into the repository, if the repository is on this machine.

### 7. Uninstall

1. Open Settings, Apps, Installed apps, find "DOE Oracle Test Harness", and choose **Uninstall**.

Expected:

- No administrator prompt.
- The app is gone from Installed apps, the Start menu, and the desktop.
- The folder `%LOCALAPPDATA%\Programs\DOE Oracle Test Harness` is gone.
- The folder `%APPDATA%\DOE Oracle Test Harness` is still there, with `harness.db` in it. This is on purpose: results survive an uninstall.

### 8. Reinstall

1. Install the same MSI again, as in step 1, and start the harness.

Expected:

- It installs and starts as before.
- The bar at the top shows a new session ID.
- The trials from steps 3 and 4 are still listed under "Saved trials": uninstalling and reinstalling lost nothing.
- Copilot may ask you to sign in again. On the work account tested so far, the sign-in does not survive closing the harness.

### 9. Leave the machine as you want it

- To keep using the harness, leave it installed.
- For a true clean start (for example before an official session), uninstall, then delete `%APPDATA%\DOE Oracle Test Harness`. This deletes every saved result and the Copilot sign-in, so export first if the data matters.

## Results

| Step | Result (pass, fail, not tested) | Notes |
| --- | --- | --- |
| 1. Install with no admin rights | | |
| 2. First launch | | |
| 3. One Oracle trial | | |
| 4. One Copilot trial | | |
| 5. Export | | |
| 6. Where the data went | | |
| 7. Uninstall | | |
| 8. Reinstall | | |

Measured on this machine (optional, but useful for the reference machine record):

| | |
| --- | --- |
| Time to install (double-click to Finish) | |
| Time from starting the harness to its window showing | |
| Oracle trial response time shown (ms) | |
| Copilot trial response time shown (ms) | |

## If something fails

Collect these and attach them to the issue or the pull request:

1. A screenshot of the harness window, including "App info".
2. The exact text of any error message.
3. The self-check report. In PowerShell:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DOE Oracle Test Harness\DOE Oracle Test Harness.exe" --self-check | Out-Null
   Get-Content "$env:APPDATA\DOE Oracle Test Harness\self-check\report.json"
   ```

   The self-check opens and closes two Chromium windows by itself, contacts no site, and does not touch your saved results.
4. If the installer itself failed, an install log. In PowerShell, from the folder with the MSI (use the real file name):

   ```powershell
   msiexec /i "DOE Oracle Test Harness-0.2.57-x64.msi" /l*v install.log
   ```
