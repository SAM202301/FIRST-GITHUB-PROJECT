# Habits — a private habit tracker that lives on your phone

A habit tracker you install straight onto your iPhone (or Android) Home Screen.
It does **not** come from the App Store and needs no Apple developer account,
so nothing expires and nobody can switch it off. All your data stays on the
phone. There are no accounts, no servers and no tracking.

## What it does

| | |
|---|---|
| **Daily habits** | Tick or untick every day. You can limit a habit to certain weekdays (e.g. Mon–Fri). |
| **Weekly goals** | E.g. "Exercise 3× per week". Tick on the days you do it; the week is met once you reach the target. |
| **Monthly goals** | E.g. "Review budget 1× per month". |
| **Today screen** | One place to tick everything, go back to earlier days to fix missed ticks, and log a mood plus a note. |
| **Week view** | A grid of every habit across the week, with a week score. |
| **Month view** | A colour-coded calendar of how complete each day was, plus a monthly tally. |
| **Progress** | Overall score, streaks, a list of **what you're doing well vs. what needs work**, habits that are improving or slipping, best and worst weekday, a score for each life area (Health, Mind, Finance…) and a 12-week trend. |
| **Reminders** | Defaults to **6 PM and 8 PM**. You can change, add or remove times. |
| **Backup** | Save a backup file to the Files app and restore it later, or on a new phone. |
| Extras | Dark mode, streaks 🔥, archiving habits without losing their history, works fully offline. |

## Installing it on your iPhone

The app is plain HTML, CSS and JavaScript with no build step. It has to be
opened from a web address **once** so Safari can install it:

1. **Host the folder (free):** in this GitHub repo go to **Settings → Pages**.
   Set *Source* to *Deploy from a branch*, choose this branch and `/ (root)`, then save.
   After a minute you get an address like `https://<you>.github.io/FIRST-GITHUB-PROJECT/`.
   (GitHub Pages is free for public repos. Alternatively, drag the folder onto
   https://app.netlify.com/drop.)
2. On the iPhone, open that address in **Safari**.
3. Tap **Share → Add to Home Screen → Add**.
4. Open **Habits** from the Home Screen. Everything is now stored on the phone,
   and the app works with no internet at all.

> Use the Home Screen icon, not the Safari tab. iOS keeps a separate storage
> area for each, and the installed app is the one that keeps your data
> permanently.

## Getting reminders at 6 PM / 8 PM

iOS pauses web apps when they aren't open, so the app can't wake itself up to
alert you. Set up one of these once. Both run entirely on your phone:

- **Calendar (easiest):** *Settings → Add reminders to Calendar*. This adds a daily
  repeating "✅ Habit check-in" event with an alert at each of your reminder times.
  You can also open `reminders/6pm-and-8pm.ics` from the website in Safari.
- **Shortcuts app:** *Automation → ＋ → Time of Day → 6:00 PM, Daily, Run
  Immediately → action "Show Notification"*. Repeat for 8:00 PM.

When the app is open, or you open it after a reminder time, it also shows an
"Evening check-in" banner. If you allow notifications, it shows a notification
listing what's still unticked.

## Your data

- Everything is stored in the app's storage on this device. Nothing is uploaded.
- Use **Settings → Save backup** now and then, e.g. to iCloud Drive / Files.
  Deleting the Home Screen app deletes its data, and restoring a backup brings it back.

## Files

```
index.html            page shell
styles.css            styling (light + dark)
app.js                all app logic
sw.js                 service worker – caches the app for offline use
manifest.webmanifest  install metadata
icons/                app icons
reminders/*.ics       ready-made daily calendar reminders (6 PM, 8 PM, both)
```

To try it on a computer, run `python3 -m http.server` in this folder and open http://localhost:8000.
