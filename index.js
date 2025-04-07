
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");

// Command handlers
async function tagAll(sock, groupId, msg) {
  try {
    const group = await sock.groupMetadata(groupId);
    const participants = group.participants;
    let mentions = [];
    let message = "🔊 Attention everyone!\n\n";
    
    participants.forEach(participant => {
      mentions.push(participant.id);
      message += `@${participant.id.split('@')[0]}\n`;
    });

    await sock.sendMessage(groupId, { 
      text: message,
      mentions: mentions
    });
  } catch (error) {
    console.error("Error in tagAll:", error);
    await sock.sendMessage(groupId, { text: "Error: This command only works in groups!" });
  }
}

async function banUser(sock, groupId, args) {
  try {
    if (!args[0]) {
      await sock.sendMessage(groupId, { text: "Please mention a user to ban!" });
      return;
    }

    const userToRemove = args[0].replace('@', '') + '@s.whatsapp.net';
    await sock.groupParticipantsUpdate(groupId, [userToRemove], "remove");
    await sock.sendMessage(groupId, { text: `✅ User has been removed from the group!` });
  } catch (error) {
    console.error("Error in banUser:", error);
    await sock.sendMessage(groupId, { text: "Error: Make sure I'm admin and the user exists!" });
  }
}

async function bigFunction(sock, from) {
  const texts = [
    "🌟 *BIG TEXT* 🌟",
    "█▀█ █▄░█ █▀▀",
    "█▀▀ █░█ █▄█",
    "▀█▀ █░█░█ █▀█",
    "░█░ ▀▄▀▄▀ █▄█"
  ];
  
  await sock.sendMessage(from, { text: texts.join('\n') });
}

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startSock();
            }
        } else if (connection === "open") {
            console.log("Connected to WhatsApp!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const msg = messages[0];
        if (!msg.message) return;
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

        if (!messageContent) return;

        // Handle commands
        if (messageContent.startsWith("!")) {
            const [command, ...args] = messageContent.slice(1).split(" ");
            switch (command.toLowerCase()) {
                case "tagall":
                    await tagAll(sock, from, msg);
                    break;
                case "ban":
                    await banUser(sock, from, args);
                    break;
                case "big":
                    await bigFunction(sock, from);
                    break;
                default:
                    await sock.sendMessage(from, { text: "Unknown command." });
            }
        }
    });
};

startSock();
