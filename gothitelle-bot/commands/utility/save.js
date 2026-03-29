const { getStream } = require("puppeteer-stream")
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")

async function waitUntilVictory(timeout, page) {
	let ret = new Promise(async (resolve, reject) => {
		setTimeout(() => {
			if (!ret.isResolved) {
				reject()
			}
		}, timeout)

		await checkForVictory(page)
		resolve()
	})
	return ret
}

async function checkForVictory(page) {
	let victory = await page.$$eval('div[class="battle-history"]', (els) =>
		els.map((e) => e.textContent)
	)
	victory = victory[victory.length - 1].endsWith(" won the battle!")

	if (!victory) {
		// Wait for 1 second before calling checkForVictory again
		await new Promise((resolve) => setTimeout(resolve, 1000))
		await checkForVictory(page)
	} else {
		return
	}
}

const { SlashCommandBuilder, AttachmentBuilder } = require("discord.js")

const activeSaveCommands = new Map()

module.exports = {
	data: new SlashCommandBuilder()
		.setName("save")
		.setDescription("Download a showdown replay as mp4/webm.")
		.addStringOption((option) =>
			option
				.setName("link")
				.setDescription("The replay link of a pokémon showdown battle.")
				.setRequired(true)
		)
		.setDMPermission(false),

	async execute(interaction) {
		// Check if the user has an active save command
		if (activeSaveCommands.has(interaction.user.id)) {
			await interaction.reply(
				"You already have an active save command running."
			)
			return
		}
		let newFilePath = ""
		try {
			const link = interaction.options.getString("link")
			if (
				!(
					link.startsWith("https://replay.pokemonshowdown.com/") ||
					link.startsWith("http://replay.pokemonshowdown.com/")
				) &&
				!(link.endsWith(".json") || link.endsWith(".log"))
			)
				return await interaction.reply({
					content: "Invalid replay url",
					ephemeral: true,
				})

			await interaction.reply("!!Booting Replay!!")
			const response = await fetch(link.split("?")[0] + ".json")
			if (!response.ok) {
				return await interaction.editReply(
					"!!Booting Replay!!\n❌ I cannot join that url. Please ensure it is a valid showdown replay."
				)
			}

			// Mark the user as having an active save command
			activeSaveCommands.set(interaction.user.id, true)

			const data = await response.json()
			const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g))
			const totalTurns = parseInt(matches[matches.length - 1][1])
			await interaction.editReply(
				"<a:loading_grey:774251894301523998> Opening Replay..."
			)
			const file = fs.createWriteStream(
				`./replay-${interaction.user.id}.webm`
			)
			const page = await interaction.client.browser.newPage()
			await page.goto(link, {
				waitUntil: "load",
			})
			await page.addStyleTag({
				content: `
                header {
                    display: none !important;
                }
                .bar-wrapper {
                    margin: 0 0 !important;
                }
                .battle {
                    top: 0px !important;
                    left: 0px !important;
                    ${nochat ? "margin: 0 !important;" : ""}
                }
                .battle-log {
                    top: 0px !important;
                    left: 641px !important;
                    ${nochat ? "display: none !important;" : ""}
                }
                `,
			})
			await page.waitForSelector(".playbutton")
			// change speed to fast when the video exceeds 20 turns
			if (totalTurns > 20)
				await page.select('select[name="speed"]', "fast")
			// customization done, now remove scrollbar by making below elements invisible
			await page.addStyleTag({
				content: `
                .replay-controls {
                    display: none !important;
                }
                #LeaderboardBTF {
                    display: none !important;
                }
                `,
			})
			const stream = await getStream(page, {
				audio: true,
				video: true,
			})

			await page.click('button[name="play"]')
			stream.pipe(file)

			await interaction.editReply(
				`✅ Replayed Opened!\n🔴 Saving Replay..  (this may take a while.. preferably not more than ${(
					(totalTurns * 7) /
					60
				).toFixed(2)} minutes)`
			)
			// Start checking for victory, upto 2 minutes 30 seconds
			try {
				await waitUntilVictory(150000, page)
			} catch {}
			// Wait for 2 seconds so that the battle has completely ended as we read the text earlier than it getting fully animated
			await new Promise((resolve) => setTimeout(resolve, 1500))

			stream.destroy()
			file.close()
			console.log("finished recording")
			try {
				await page.close()
			} catch (error) {
				console.log(error)
			}
			await interaction.editReply(`✅ Replayed Opened!\n🟢 Saved Replay!`)
			try {
				console.log("processing started")
				await fixwebm(interaction.user.id)
				console.log("processed")
			} catch (error) {
				console.error("Metadata fixing failed:", error)
			}
			const filePath = `./replay-${interaction.user.id}-save.webm`
			const stats = fs.statSync(filePath)
			const fileSizeInBytes = stats["size"]
			//Convert the file size to megabytes
			const fileSizeInMegabytes = fileSizeInBytes / 1000000.0
			const premiumTier = interaction.guild.premiumTier
			if (fileSizeInMegabytes >= 8) {
				if (premiumTier <= 1) {
					await interaction.editReply(
						`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n<a:Loading_Color:774251893874098186> Compressing the file to under 8mb\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
					)
					// requires compression to 8mb
					newFilePath = await compress(
						interaction.client.browser,
						8,
						filePath
					)
					await interaction.editReply(
						`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n☑️ File compressed to under 8mb.\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
					)
					console.log("attaching file")
					const att = new AttachmentBuilder(newFilePath)
					console.log("attached!")
					try {
						console.log("sending!")
						await interaction.followUp({
							content: `<@${interaction.user.id}> processing finished!`,
							files: [att],
						})
					} catch {
						console.log("failed..")
						await new Promise((resolve) =>
							setTimeout(resolve, 10000)
						)
						console.log("trying again!")
						const att_new = new AttachmentBuilder(newFilePath)
						await interaction.followUp({
							content: `<@${interaction.user.id}> processing finished!`,
							files: [att_new],
						})
						console.log("woo")
					} finally {
						return
					}
				} else if (premiumTier === 2) {
					if (fileSizeInMegabytes >= 50) {
						await interaction.editReply(
							`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n<a:Loading_Color:774251893874098186> Compressing the file to under 8mb\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
						)
						// requires compression to 50mb
						newFilePath = await compress(
							interaction.client.browser,
							50,
							filePath
						)
						await interaction.editReply(
							`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n☑️ File compressed to under 50mb.\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
						)
						const att = new AttachmentBuilder(newFilePath)
						try {
							await interaction.followUp({
								content: `<@${interaction.user.id}> processing finished!`,
								files: [att],
							})
						} catch {
							await new Promise((resolve) =>
								setTimeout(resolve, 10000)
							)
							return await interaction.followUp({
								content: `<@${interaction.user.id}> processing finished!`,
								files: [att],
							})
						} finally {
							return
						}
					}
				} else if (premiumTier === 3) {
					if (fileSizeInMegabytes >= 100) {
						// requires compression to 100mb
						await interaction.editReply(
							`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n<a:Loading_Color:774251893874098186> Compressing the file to under 8mb\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
						)
						newFilePath = await compress(
							interaction.client.browser,
							100,
							filePath
						)
						await interaction.editReply(
							`✅ Replayed Opened!\n🟢 Saved Replay!\nFile is too big! (${fileSizeInMegabytes})MB\n☑️ File compressed to under 100mb.\n(Use this command in a boosted server of Level 2/3 for me to send you a higher quality download)`
						)
						const att = new AttachmentBuilder(newFilePath)
						try {
							await interaction.followUp({
								content: `<@${interaction.user.id}> processing finished!`,
								files: [att],
							})
						} catch {
							await new Promise((resolve) =>
								setTimeout(resolve, 10000)
							)
							return await interaction.followUp({
								content: `<@${interaction.user.id}> processing finished!`,
								files: [att],
							})
						} finally {
							return
						}
					}
				}
			}
			const att = new AttachmentBuilder(filePath)
			await interaction.followUp({
				content: `<@${interaction.user.id}> processing finished! (!Highest Quality!)`,
				files: [att],
			})
		} catch (error) {
			console.log(error)
		} finally {
			activeSaveCommands.delete(interaction.user.id)
			try {
				fs.unlinkSync(`./replay-${interaction.user.id}-save.webm`)
			} catch (err) {}
			try {
				fs.unlinkSync(newFilePath)
			} catch (err) {}
			try {
				fs.unlinkSync(`./replay-${interaction.user.id}.webm`)
			} catch (err) {}
		}
	},
}

// Create a FFmpeg command to fix the metadata
async function fixwebm(userId) {
	return new Promise((resolve, reject) => {
		const command = ffmpeg(`./replay-${userId}.webm`)
			.withVideoCodec("copy")
			.withAudioCodec("copy") // Copy the video and audio streams without re-encoding
			.output(`./replay-${userId}-save.webm`)
			.on("end", () => {
				resolve()
			})
			.on("error", (err) => {
				console.error("Error fixing metadata:", err)
				reject(err)
			})

		command.run()
	})
}

async function compress(browser, size, filePath) {
	const page = await browser.newPage()
	const client = await page.target().createCDPSession()
	await client.send("Page.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: __dirname,
	})
	await page.setDefaultTimeout(60000)
	console.log(
		"waiting on site to load... this site takes longer to finish loading"
	)
	await page.goto("https://8mb.video", {
		waitUntil: "load",
	})
	await page.waitForSelector("#bb")
	const [fileChooser] = await Promise.all([
		page.waitForFileChooser(),
		page.click('label[id="bb"]'),
	])
	let waitTime = 10000 // 10 seconds to download an 8mb video
	switch (size) {
		case 50:
			await page.click('input[id="size50"]')
			waitTime = 20000
			break
		case 100:
			await page.click('input[id="size100"]')
			waitTime = 30000
			break
	}

	await fileChooser.accept([filePath])
	console.log("yei")
	await page.click('input[type="button"]')
	console.log("processing!!")
	console.log("waiting on replay to finish with compression")
	try {
		await page.waitForSelector("#dllink")
	} catch {
		console.log("waited 60 seconds... compression didn't finish")
	}
	console.log("compression finished")
	await new Promise((resolve) => setTimeout(resolve, 1000))
	const element = await page.$('a[id="dllink"]')
	const replayPath = await element.evaluate((el) => el.textContent)
	await new Promise((resolve) => setTimeout(resolve, 1000))
	await page.click('a[id="dllink"]')
	console.log(
		"downloading + lets just wait 10 seconds for hoping the download finishes"
	)
	await new Promise((resolve) => setTimeout(resolve, waitTime))
	console.log("waited", __dirname + replayPath)
	try {
		await page.close()
	} catch (error) {
		console.log(error)
	}
	return __dirname + "\\" + replayPath
}
