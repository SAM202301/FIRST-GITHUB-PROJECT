# Habits app

Offline habit-tracker web app (plain HTML/CSS/JS, no build step), served by
GitHub Pages from the default branch: https://sam202301.github.io/FIRST-GITHUB-PROJECT/

## Releasing a change

The installed app only offers an update when the version changes. For every
change that should reach the phone:

1. Bump the version in **all three** places (they must match):
   - `APP_VERSION` in `app.js`
   - `VERSION` in `sw.js`
   - `"version"` in `version.json`
2. Write a one-sentence, user-facing `"notes"` in `version.json`; it is shown
   in the "Update available" banner.
3. If you add a new file the app needs offline, add it to `FILES` in `sw.js`.

User data lives only in the phone's localStorage (`habits.v1`); never change
its shape without migrating existing data in `load()`.
