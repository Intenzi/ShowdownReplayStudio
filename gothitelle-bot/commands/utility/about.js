const { SlashCommandBuilder } = require("discord.js")

module.exports = {
    data: new SlashCommandBuilder()
        .setName("about")
        .setDescription("About the bot"),
    async execute(interaction) {
        await interaction.reply(
            "Developed by `intenzi`\nIt is an open-source application built to serve Pokémon Showdown replays by recording them into a mp4 video. Providing it as a discord bot allows the standalone function to be shared with other users while also uploading the videos to the cloud (discord cdn).\n:star: Repository -> https://github.com/intenzi/ShowdownReplayDownloader"
        )
    },
}
