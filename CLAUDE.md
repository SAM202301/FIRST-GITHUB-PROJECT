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
4. `INSTALL_IMMEDIATELY` in `sw.js`: `true` makes the release install on its
   own (even while the app is locked); `false` waits for the person to tap
   "Install update". Use `true` for fixes that unblock someone.

The app lock (`habits.lock` in localStorage) is kept out of backups. Never add
a way past it that doesn't require the iPhone's own Face ID or passcode
(WebAuthn with user verification) or the backup PIN.

User data lives only in the phone's localStorage (`habits.v1`); never change
its shape without migrating existing data in `load()`.
