## Setup

1. Fork the repository and clone it locally.
2. Perform `npm install`
3. `npm start` to spin it up.

Create a new branch to make changes, commits and then raise a Pull Request accordingly.

## Architecture

### Chromium

- This project utilises `puppeteer-stream` for recording the replays.
- It spins up four headless chromiums by default and assigns more dynamically (upto 6 in total) based on bulk recording limits.
- There is resource saving logic in-place to close the headless chromiums upon no active recordings for 30+ minutes. They get spinned up again individually once there is activity.
- uBlock Origin Lite has been added as an external extension.

### Website

- Backend server is present in `main.js` and the website is run at http://localhost:57335
- Frontend is present in `public/` and utilises socket.io to communicate with the backend for relaying replay recording status, info, configs.

### Recorder

- `recorder.js` handles the entire replay recording logic from replay site/file load -> css injections -> victory wait -> file stream completion.
- For linux users, ffmpeg-stream and ffmpeg-static is additionally installed automatically (`postinstall.js`). (Recording is done in webm format for them and then converted to mp4 via ffmpeg automatically)

### Bundling

- `pkg` is used to bundle the application to make it executable on different operating systems without requiring nodejs to be installed.
- Their specific scripts are present at `scripts/` directory.
- Methods to use are `npm run package:win`, `npm run package:mac`, `npm run package:linux`
- I only provide Windows packaged exe as it is user friendly.
    - While MacOS packaged app works, it faces permission issues and requires multiple non tech-friendly steps.
    - It is hard to distribute for various Linux distros without users packaging it on their own separately.

### Legacy:

Since a prior version consisted of cmdline usage and a separate discord bot interface, I have stored the discord bot related files in `gothitelle-bot/` directory for reference, archive.
