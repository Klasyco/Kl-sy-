
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, makeInMemoryStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");

// Initialize Express
const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(3000, "0.0.0.0", () => console.log("Web server running..."));

const store = makeInMemoryStore({ logger: pino().child({ level: "silent" }) });
const bannedUsers = new Set();
let autoReplyEnabled = true;

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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const sender = msg.key.participant || msg.key.remoteJid;
        const message = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const command = message.startsWith("!") ? message.slice(1).trim().split(" ") : null;

        if (command) {
            const [cmd, ...args] = command;
            const user = args[0]?.replace("@", "") + "@s.whatsapp.net";

            switch (cmd.toLowerCase()) {
                case "tagall":
                    if (!isGroup) return;
                    const meta = await sock.groupMetadata(from);
                    const mentions = meta.participants.map(p => p.id);
                    const names = mentions.map(id => `@${id.split("@")[0]}`).join(" ");
                    await sock.sendMessage(from, { text: names, mentions });
                    break;

                case "tagadmins":
                    if (!isGroup) return;
                    const groupMeta = await sock.groupMetadata(from);
                    const admins = groupMeta.participants.filter(p => p.admin).map(p => p.id);
                    const adminTags = admins.map(id => `@${id.split("@")[0]}`).join(" ");
                    await sock.sendMessage(from, { text: adminTags, mentions: admins });
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
                    const info = await sock.groupMetadata(from);
                    await sock.sendMessage(from, {
                        text: `*Group Info*\nName: ${info.subject}\nCreated: ${new Date(info.creation * 1000).toDateString()}\nMembers: ${info.participants.length}`
                    });
                    break;

                case "status":
                    if (!args[0]) return;
                    const statusJid = args[0].replace(/\D/g, "") + "@s.whatsapp.net";
                    const statuses = store.presences[statusJid]?.lastKnownPresence;
                    await sock.sendMessage(from, { text: `Status: ${statuses || "Unavailable"}` });
                    break;

                case "sticker":
                    if (!msg.message.imageMessage) return;
                    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    await sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
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

                case "big":
                    await sock.sendMessage(from, { text: "Running a BIG function..." });
                    break;

                default:
                    await sock.sendMessage(from, { text: "Unknown command." });
            }
        } else if (autoReplyEnabled && isGroup && !bannedUsers.has(sender)) {
            await sock.sendMessage(from, { text: "I'm a bot. Type !help for commands." });
        }
    });
};

startSock();
