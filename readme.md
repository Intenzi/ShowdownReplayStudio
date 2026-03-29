# Showdown Replay Studio (v1.1)

An _actual_ Pokémon Showdown Replay Downloader.

📥Download any PS replay via its link into **mp4/webm** format.

Utilise as a cmd line application with various customization options and the ability to batch download replays simultaneously.

Alternately deploy as a discord bot, upload and save replays to the cloud via discord cdn while sharing with friends.

## Demonstration

[🔗 Invite the already hosted discord bot for instant use!](https://discord.com/api/oauth2/authorize?client_id=1149183749167251489&permissions=0&scope=applications.commands%20bot)
(Both videos below have been compressed to under 10mb)

-   ### Discord Bot


https://github.com/Intenzi/ShowdownReplayDownloader/assets/62426443/ab350c7c-a392-40c6-9df1-f35ab4c11d11


-   ### Command Line Application


https://github.com/Intenzi/ShowdownReplayDownloader/assets/62426443/2464cc76-6b52-40a6-a8f5-f5c7bfabf0a1


## Setup

Clone this repository (i.e. download all files).

You can click on Code -> Download zip and then unzip the downloaded project.

1. Install Node.js (https://nodejs.org/en/download)
2. Install ffmpeg (https://ffmpeg.org/download.html)
3. Open cmd prompt at the project directory's path and enter `npm install` (example:- C:\Users\tenzi\Documents\VSC Folders\ShowdownReplayDownloader> npm install)

-   ### Discord Bot
    1. Head over to https://discord.com/developers/applications and create a new application (click on the New Application button).
    2. Once created, Go to the "Bot" tab and then click "Add Bot".
    3. Untick all the priveleged intents that are enabled (you won't be needing them)![](https://cdn.discordapp.com/attachments/1006770227687718952/1159863545324904508/image.png?ex=6532921a&is=65201d1a&hm=5985af37c4a68b86c8ea027a36bb641c2742ea827f6d8cf463edbbb5e6244f9f&)
    4. Copy the token of your bot. You will need it for the next step. Head over to "General Information" tab and copy the application ID as well.
    5. Invite the bot to your discord server via this link (make sure you paste in your actual clientId instead of 12345)-> https://discord.com/api/oauth2/authorize?client_id=12345&permissions=0&scope=bot
    1. Make a `config.json` file inside the `gothitelle-bot/` directory.
        ```json
        {
            "token": "pasteYourBotToken",
            "clientId": "pasteYourBotId"
        }
        ```
    2. Open your terminal in the `gothitelle-bot/` directory: `cd gothitelle-bot`
    3. Install bot dependencies: `npm install`
    4. Enter `node deploy-commands.js` to deploy slash commands.
    5. Run your discord bot via `node index.js`
- ### Cmd Application
    1. From the project root, enter `node download.js -h` to view syntax.

## Usage

Upon deploying the commands of the discord bot and running the bot. You will be able to utilise three slash commands (via `/` prefix).

Namely, `/ping`, `/about` and `/save`
Use the slash command `/save` and enter the showdown replay link that you would like the bot to save. The process is simple and the bot will ping you on completion of the recording.

**For the command line application:-**

Usage is via -> node download.js -l/-links [replay links separated by a comma]
Example: `node download.js -l https://replay.pokemonshowdown.com/gen9unratedbattle-12345`

The cmd line application comes with various options to customize the way you want your replays to be saved:-

-   --links (-l)
    -   List of ps replay links separated by a comma or space that you want to download.
        (Windows users need to add quotation marks "" to the start and end of the list of replays for multiple replays)
-   --speed (-s)
    -   Speed of the ps replay (fast/slow/normal/"really fast"/"really slow")
    -   Default: `normal`
-   --theme (-t)
    -   Color scheme of ps (light/dark)
    -   Default: `light`
-   --nomusic
    -   Disable music
-   --noaudio
    -   Records only video, audio is not captured.
-   --nochat
    -   Won't record the text chatbox to the right of the replay. (Recommended)
-   --bulk (-b)
    -   This is an important option, it decides how many replays will be recorded simultaneously (at the same time).
    -   Albeit time efficient, bulk recording all replays simultneously can be resource intensive and lead to poorer quality videos.
    -   Accepted values -> any positive number (1 or above) / all
    -   Default: `all`

### Examples:-

-   `node download.js -l https://replay.pokemonshowdown.com/123randbats`
    -   This will download the replay as expected.
-   `node download.js -l "https://replay.pokemonshowdown.com/123randbats, https://replay.pokemonshowdown.com/456gen81v1" -b 1 --nochat`
    -   This will download the replays **one at a time** and will not record the text chat-box.
-   `node download.js -l "sample1, sample2, sample3, sample4, sample5" -b 3 -s fast -t dark`
    -   This will download the replays **three at a time** (upto three videos simultaneously) with speed set to `fast` and `dark` theme.

## Contribution

All contributions are highly welcome! Please raise an issue to state that you're working on an improvement for the code (be a bit descriptive). Send a Pull Request upon completion and I'll gladly accept the PR.

Here's [an introductory guide](https://opensource.com/article/19/7/create-pull-request-github) on how to fork a project and send a pull request to a github repository.

### Improvements that you can directly contribute:-

1. The discord bot is interactions only. However, we are utilising the bot user as well to run our bot. This is due to utilising djs package. It would be appreciated if you can improve the discord bot to be http only as that will improve the bot's performance.
2. Fix the issue of puppeteer-stream recordings not being able to correctly store metadata. Which leads to seeking not being possible. Currently ffmpeg is utilised solely to properly add metadata to the video. This dependancy can thus be removed upon finding a direct solution to the problem.
3. Currently, in order to compress the recordings for uploading to the discord cdn, 8mb.video website is being utilised via automation. It would be better to not have to rely on the website, by utilising a native approach instead. For example, ffmpeg with proper file compression options with decent performance and reliable file size reduction.
4. A progress bar for each recording in the cmdline application. The replay recorder's code has access to the current turn being recorded and the total turns of the replay. A progress bar displaying the status of completion towards the recording by utilising these two variables will make the application neater and enhance the user experience.
5. Build a website for software as a service application. The discord bot application is easily accessible and robust. However, it is the norm to build a website instead for global reach and adoption. There will be a far wider audience of users who would want access to downloading showdown replays by the click of a button instead of the cmdline application setup process or hosting/using the discord bot version. It will naturally cost resources to run the website and provide this service. A user-based subscription model for free download of replays with bulk replay downloads behind a paywall can thus be sold as a premium feature of the software. Feel free to discuss it further with me on discord @intenzi/the issues tab of this repo!
6. Bulk recording is still experimental with various issues that arise (for which I had to wrap a try catch block onto end process at end of program and at checkForVictory function). They include errors from system process being unable to terminated and certain videos not getting recorded to all of their turns. It is a bit tacky and needs ironing out to be useable stably.
7. Feel free to bring in bug fixes and any other features that you would like!

### 🌸 Like the project?

You can help sponsor the project (and me) by tipping me at ko-fi -> https://ko-fi.com/intenzi
