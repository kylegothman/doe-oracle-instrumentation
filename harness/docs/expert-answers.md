# Entering expert answers

How the Researcher records the expert's answers to the 12 standard questions on the **Expert Responses** tab (UC-5, stories #41 to #43). The expert's answers are the reference the Oracle, Copilot, and Google are compared against, and the turnaround is how long the expert took to reply.

Everything is saved as you go. You can stop after any answer, close the harness, and carry on later.

## 1. The expert

Fill in the **Expert** card and click **Save Expert**.

| Field | What to enter |
| --- | --- |
| Name | The expert's name. Required. It is the only personal detail the harness stores (NFR-7): there is no field for an email address or for notes. |
| Source | **Email** or **Interview**: how the answers arrived. |
| Outreach sent | The date and time the questions were sent to the expert. Required. |
| First answer received | The date and time the expert's first answer arrived. Leave it empty until the reply arrives, then come back and fill it in. |

Enter both times in the computer's local time; the card names the time zone it uses. They are stored as ISO 8601 UTC with milliseconds, and shown back as the local times you entered.

**Turnaround** is the first answer minus the outreach. The card shows it in days and hours, rounded down to whole hours ("14 days 3 hours"), with the stored milliseconds beside it. Under a day it is shown in hours, and under an hour in minutes. It is empty while the first answer is empty. It is stored once, with the expert, never with an answer.

The harness refuses these, says which field is wrong under that field, and saves nothing:

- an empty name;
- no outreach time;
- a date without its time, or the other way round;
- a first answer earlier than the outreach (the same time is accepted, as a turnaround of zero);
- a new expert with the name of an expert that is already saved, whatever its capitals or spacing. Pick that expert from the **Expert** list instead.

To change a saved expert, for example to add the first answer time, pick them from the **Expert** list, edit, and click **Save Changes**. That updates the expert; it never makes a second record. When exactly one expert is saved, the page opens on them.

### When the clocks change

The turnaround is real elapsed time. Across the night the clocks go back, 14 days 3 hours on the calendar is 14 days 4 hours of elapsed time, and that is what is stored. A time in the hour that is skipped when the clocks go forward is refused. A time in the hour that happens twice when they go back is taken as the first of the two.

## 2. The answers

Once an expert is saved or picked, the **Answers** card is under the expert.

1. Pick the question, from the **Question** list or from the Q1 to Q12 markers. Only the 12 standard questions are offered, and the full question text is shown.
2. Paste or type the expert's answer.
3. Click **Save Answer**.

The answer is stored exactly as pasted, except that blank lines at the very start and the very end are dropped. Indentation, blank lines between paragraphs, and spaces at the end of a line are kept. An answer that is empty, or only spaces and blank lines, is refused under the answer box and nothing is saved.

A check mark on a marker means the question has an answer. The badge and the line under the markers give the count and list the open questions, for example "3 answered, 9 open. Open: Q4, Q5, ...". Picking an answered question shows its saved text, when it was saved, and its Test #.

Text you have typed for a question and not saved stays in the box while you look at other questions, until you close the harness or pick another expert.

## 3. Replacing an answer

Pick the answered question, change the text, and click **Save Answer**. The card shows the existing answer and asks:

- **Replace Answer** saves the new text as the question's answer. The old answer is kept in the database, marked superseded, and is left out of every export. The new answer takes over the old one's Test #.
- **Cancel** saves nothing. The old answer stays, and your new text stays in the box.

## 4. Stopping and resuming

Close the harness whenever you like. After the next launch, the **Expert Responses** tab shows the same expert, the same answered and open questions, and opens on the first open question.

## 5. Exporting

On the **Export** tab, choose **Expert answers only** under Subject (see "Exporting" in the README).

- In **Session** mode, Expert answers only exports the answers from every session, so answers typed before a restart are included. To export only some of them, switch to **Date range**: an answer counts from when it was entered.
- Each answer is one row. The turnaround, the outreach time, and the first answer time are filled only on the row of the expert's lowest question number; the other rows leave those cells empty.

## If a save fails

If the database itself refuses a save (a full disk, a locked file), the page says the record was kept and can be retried. Go to the **Export** tab and click **Retry** under "Saves waiting for a retry", then come back: the page reads the saved data again each time the tab is opened. Do not enter the same expert or answer a second time while its save is waiting, or a retry can leave two records.

## Not in the harness

Deleting an expert or an answer, a history of superseded answers, importing answers from a file, keywords, and scoring.
