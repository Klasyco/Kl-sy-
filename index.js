
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, makeInMemoryStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const store = makeInMemoryStore({ logger: pino().child({ level: "silent" }) });
const bannedUsers = new Set();
let autoReplyEnabled = true;
let customReplyText = "I'm a bot. Type !menu for help.";
let activePoll = null;

app.get("/", (req, res) => res.send("WhatsApp Bot is running."));
app.listen(PORT, "0.0.0.0", () => console.log(`Keep-alive web server running on port ${PORT}`));

const getTextFromMessage = (msg) => {
    const m = msg.message;
    if (!m) return "";
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ""
    );
};

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            startSock();
        } else if (connection === "open") {
            console.log("Connected to WhatsApp!");
        }
    });

    sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
        if (action === "add") {
            for (const participant of participants) {
                await sock.sendMessage(id, {
                    text: `Welcome to the group, @${participant.split("@")[0]}!`,
                    mentions: [participant]
                });
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const sender = msg.key.participant || msg.key.remoteJid;
        const message = getTextFromMessage(msg);
        const command = message.startsWith("!") ? message.slice(1).trim().split(" ") : null;

        if (command) {
            const [cmd, ...args] = command;
            const user = args[0]?.replace("@", "") + "@s.whatsapp.net";

            switch (cmd.toLowerCase()) {
                case "menu":
                    const menuText = `
╔════◇ *🤖 WHATSAPP BOT MENU* ◇════╗

┃  *COMMANDS LIST:*
┃  ✦ *!menu* — Show this menu
┃  ✦ *!tagall* — Tag all members
┃  ✦ *!tagadmins* — Tag only admins
┃  ✦ *!ban @user* — Ban a member
┃  ✦ *!kick @user* — Kick a member
┃  ✦ *!kickall* — Kick all (risky!)
┃  ✦ *!add 234xxxx* — Add member
┃  ✦ *!mute @user* — Demote member
┃  ✦ *!groupinfo* — View group details
┃  ✦ *!status 234xxxx* — Get user status
┃  ✦ *!sticker* — Turn image/video to sticker
┃  ✦ *!grouppic* — Show group photo
┃  ✦ *!autoreply on/off* — Toggle replies
┃  ✦ *!setreply [text]* — Set reply text
┃  ✦ *!poll [question]* — Create a poll
┃  ✦ *!big* — Big test function

╠═════════════════════╗
║  *Auto-Reply Message:*  
║  You can customize it using:
║  ➤ *!setreply I am a bot. Type !help*
╚═════════════════════╝

💡 _Type any command in the group._
🔧 _Bot must be admin for group actions._

*Bot by Baileys • Hosted on Replit*
                    `.trim();
                    await sock.sendMessage(from, { text: menuText });
                    break;

                case "setreply":
                    if (!args.length) {
                        await sock.sendMessage(from, { text: "Please type your auto-reply message.\nExample: !setreply I'm a bot!" });
                        return;
                    }
                    customReplyText = command.slice(1 + cmd.length).join(" ").trim();
                    await sock.sendMessage(from, { text: `✅ Auto-reply message updated to:\n"${customReplyText}"` });
                    break;

                case "ban":
                    if (!user) return sock.sendMessage(from, { text: "Tag someone to ban!" });
                    bannedUsers.add(user);
                    await sock.sendMessage(from, { text: `@${user.split("@")[0]} has been *banned*!`, mentions: [user] });
                    break;

                case "kick":
                    if (!isGroup || !user) return;
                    await sock.groupParticipantsUpdate(from, [user], "remove");
                    break;

                case "kickall":
                    if (!isGroup) return;
                    const participants = (await sock.groupMetadata(from)).participants.map(p => p.id);
                    for (let p of participants) {
                        if (p !== sender) await sock.groupParticipantsUpdate(from, [p], "remove");
                    }
                    break;

                case "add":
                    if (!isGroup || !args[0]) return;
                    const phone = args[0].replace(/\D/g, "") + "@s.whatsapp.net";
                    await sock.groupParticipantsUpdate(from, [phone], "add");
                    break;

                case "mute":
                    if (!isGroup || !user) return;
                    await sock.groupParticipantsUpdate(from, [user], "demote");
                    break;

                case "groupinfo":
                    if (!isGroup) return;
                    const groupMeta = await sock.groupMetadata(from);
                    await sock.sendMessage(from, {
                        text: `*Group Info*\nName: ${groupMeta.subject}\nCreated: ${new Date(groupMeta.creation * 1000).toDateString()}\nMembers: ${groupMeta.participants.length}`
                    });
                    break;

                case "status":
                    if (!args[0]) return;
                    const statusJid = args[0].replace(/\D/g, "") + "@s.whatsapp.net";
                    const statuses = store?.presences?.[statusJid]?.lastKnownPresence || "Unavailable";
                    await sock.sendMessage(from, { text: `Status: ${statuses}` });
                    break;

                case "sticker":
                    if (msg.message.imageMessage || msg.message.videoMessage) {
                        const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }) });
                        await sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
                    }
                    break;

                case "autoreply":
                    if (args[0] === "on") autoReplyEnabled = true;
                    else if (args[0] === "off") autoReplyEnabled = false;
                    await sock.sendMessage(from, { text: `Auto-reply is now ${autoReplyEnabled ? "enabled" : "disabled"}` });
                    break;

                case "grouppic":
                    if (!isGroup) return;
                    const profilePic = await sock.profilePictureUrl(from, "image").catch(() => null);
                    if (profilePic) await sock.sendMessage(from, { image: { url: profilePic }, caption: "Group Profile Picture" });
                    else await sock.sendMessage(from, { text: "No group profile picture found." });
                    break;

                case "poll":
                    if (!args.length) return sock.sendMessage(from, { text: "Please enter a question for the poll!" });
                    activePoll = args.join(" ");
                    await sock.sendMessage(from, { text: `✅ Poll created: *${activePoll}*` });
                    break;

                case "big":
                    await sock.sendMessage(from, { text: "Running a BIG function..." });
                    break;

                default:
                    await sock.sendMessage(from, { text: "Unknown command." });
            }
        } else if (autoReplyEnabled && !bannedUsers.has(sender)) {
            await sock.sendMessage(from, { text: customReplyText });
        }
    });
};

startSock();
