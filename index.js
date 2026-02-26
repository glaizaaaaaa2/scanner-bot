// =====================
// ENV SETUP
// =====================
require("dotenv").config();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const SCAN_CHANNEL_ID = process.env.SCAN_CHANNEL_ID;
const ELIGIBLE_CHANNEL_ID = process.env.ELIGIBLE_CHANNEL_ID;

if (!TOKEN) throw new Error("TOKEN environment variable is missing.");
if (!CLIENT_ID) throw new Error("CLIENT_ID environment variable is missing.");

// =====================
// IMPORTS
// =====================
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "groups.json");

// =====================
// DB HELPERS
// =====================
function extractGroupId(link) {
  const m = link.match(/roblox\.com\/(communities|groups)\/(\d+)/i);
  return m ? m[2] : null;
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { groups: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();

// =====================
// DISCORD CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// =====================
// REGISTER SLASH COMMANDS
// =====================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("add_group")
      .setDescription("Owner-only: add a Roblox group")
      .addStringOption(o =>
        o.setName("name").setDescription("Group name").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("link").setDescription("Roblox group link").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("eligible")
      .setDescription("Check group membership")
      .addStringOption(o =>
        o.setName("username").setDescription("Roblox username").setRequired(true)
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

  console.log("✅ Slash commands registered.");
}

// =====================
// MESSAGE SCAN
// =====================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== SCAN_CHANNEL_ID) return;

  if (message.content.toLowerCase() === "scan") {
    await message.reply("Scan feature is active.");
  }
});

// =====================
// SLASH COMMAND HANDLER
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "add_group") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "Only owner can use this.", ephemeral: true });
    }

    const name = interaction.options.getString("name");
    const link = interaction.options.getString("link");

    db.groups.push({ name, link });
    saveDB(db);

    return interaction.reply({ content: `Saved group: ${name}`, ephemeral: true });
  }

  if (interaction.commandName === "eligible") {
    if (interaction.channelId !== ELIGIBLE_CHANNEL_ID) {
      return interaction.reply({
        content: `Use this in <#${ELIGIBLE_CHANNEL_ID}>.`,
        ephemeral: true,
      });
    }

    return interaction.reply(`Eligibility check for ${interaction.options.getString("username")} coming soon.`);
  }
});

// =====================
// READY
// =====================
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// =====================
// START
// =====================
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();