// index.js (FULL REPLACEMENT)

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
const config = require("./config.json");

const DB_PATH = path.join(__dirname, "groups.json");

// =====================
// DB helpers
// =====================
function extractGroupId(link) {
  const m = link.match(/roblox\.com\/(communities|groups)\/(\d+)/i);
  return m ? m[2] : null;
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      groups: [
        {
          name: "Nexus Arc",
          link: "https://www.roblox.com/communities/14638702/Nexus-Arc#!/about",
          waitDays: 14,
        },
      ],
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function normalizeGroups(db) {
  // Backward compatible:
  // old: groups: ["https://..."]
  // new: groups: [{ name, link, waitDays }]
  const groups = Array.isArray(db?.groups) ? db.groups : [];

  const normalized = groups
    .map((g) => {
      if (typeof g === "string") {
        const gid = extractGroupId(g);
        return { name: gid ? `Group ${gid}` : "Group", link: g, waitDays: 14 };
      }
      return {
        name: String(g?.name ?? "Group"),
        link: String(g?.link ?? ""),
        waitDays: Number.isFinite(Number(g?.waitDays)) ? Number(g.waitDays) : 14,
      };
    })
    .filter((g) => g.link);

  db.groups = normalized;
  return db;
}

let db = normalizeGroups(loadDB());

// =====================
// Roblox helpers
// =====================
function extractGamePassId(text) {
  const m = text.match(/roblox\.com\/game-pass\/(\d+)/i);
  return m ? m[1] : null;
}

function robuxAfterFee(price) {
  return Math.floor(price * 0.7);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastRes = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    lastRes = res;

    if (res.status !== 429) return res;

    const retryAfter = res.headers.get("retry-after");
    const waitMs = retryAfter
      ? Math.max(1000, Math.ceil(Number(retryAfter) * 1000))
      : 1500 * (attempt + 1);

    if (attempt === maxRetries) return res;
    await sleep(waitMs);
  }
  return lastRes;
}

async function fetchGamePassInfo(gamePassId) {
  const url = `https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/product-info`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch gamepass info (${res.status})`);
  return res.json();
}

async function fetchGamePassDetails(gamePassId) {
  const cookie = process.env.ROBLOSECURITY;
  if (!cookie) throw new Error("ROBLOSECURITY environment variable not set.");

  const url = `https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/details`;

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        cookie: `.ROBLOSECURITY=${cookie}`,
        "user-agent": "Mozilla/5.0",
        accept: "application/json",
      },
    },
    3
  );

  if (!res.ok) throw new Error(`Failed to fetch gamepass details (${res.status})`);
  return res.json();
}

function hasRegionalPricing(details) {
  const pi = details?.priceInformation;
  if (!pi) return false;

  if (pi.isInActivePriceOptimizationExperiment === true) return true;
  if (pi.isInPriceOptimizationExperiment === true) return true;
  if (pi.isPriceOptimized === true) return true;

  const enabled = Array.isArray(pi.enabledFeatures) ? pi.enabledFeatures.map(String) : [];
  const hits = [
    "RegionalPriceExperiment",
    "RegionalPricing",
    "PriceOptimization",
    "PriceOptimizationExperiment",
    "DynamicPricing",
  ];

  return enabled.some((x) => hits.includes(x));
}

async function usernameToUserId(username) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false,
    }),
  });

  if (!res.ok) throw new Error(`Failed to resolve username (${res.status})`);

  const data = await res.json();
  const found = data.data?.[0];
  return found?.id ?? null;
}

async function userGroups(userId) {
  const res = await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
  if (!res.ok) throw new Error(`Failed to fetch user groups (${res.status})`);
  return res.json();
}

// =====================
// Discord client
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
// Slash command registration
// =====================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("add_group")
      .setDescription("Owner-only: add a Roblox group for eligibility checks")
      .addStringOption((o) =>
        o.setName("name").setDescription("Display name (e.g., Nexus Arc)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("link").setDescription("Roblox group link").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("waitdays").setDescription("Unused for now (default 14)").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("eligible")
      .setDescription("Check group membership (Member / Not in Group)")
      .addStringOption((o) =>
        o.setName("username").setDescription("Your Roblox username").setRequired(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  console.log("✅ Slash commands registered.");
}

// =====================
// Scan throttling + queue (prevents 429 spam)
// =====================
const scanCooldown = new Map(); // userId -> timestamp
const COOLDOWN_MS = 5000;

let scanQueue = Promise.resolve();
function enqueueScan(task) {
  scanQueue = scanQueue.then(task).catch((e) => console.error("Scan task failed:", e));
  return scanQueue;
}

// =====================
// Message-based scan
// =====================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== config.scanChannelId) return;

  if (message.content.trim().toLowerCase() !== "scan") return;
  if (!message.reference?.messageId) return;

  const now = Date.now();
  const last = scanCooldown.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) {
    await message.reply("⏳ Slow down a bit—Roblox rate limits fast. Try again in a few seconds.");
    return;
  }
  scanCooldown.set(message.author.id, now);

  enqueueScan(async () => {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (!replied) return;

      const gpId = extractGamePassId(replied.content);
      if (!gpId) {
        await message.reply("I couldn’t find a Roblox gamepass link in the replied message.");
        return;
      }

      const link = `https://roblox.com/game-pass/${gpId}`;

      const info = await fetchGamePassInfo(gpId);
      const price = Number(info.PriceInRobux ?? info.priceInRobux ?? info.price ?? 0);

      if (!price) {
        await message.reply("I fetched the gamepass, but couldn’t read the price.");
        return;
      }

      const receive = robuxAfterFee(price);

      let details = null;
      try {
        details = await fetchGamePassDetails(gpId);
      } catch (e) {
        details = null;
        console.log(`Regional detection failed for ${gpId}:`, e?.message ?? e);
      }

      const regionalOn = details ? hasRegionalPricing(details) : false;

      if (details && regionalOn) {
        await message.reply([`${link}`, `Price: **${price}**`, `⚠️ Regional pricing detected`].join("\n"));
      } else if (details && !regionalOn) {
        await message.reply([`${link}`, `Price: **${price}**`, `You will receive: **${receive}** robux`].join("\n"));
      } else {
        await message.reply(
          [
            `${link}`,
            `Price: **${price}**`,
            `You will receive: **${receive}** robux`,
            `⚠️ Couldn’t check regional pricing right now (rate limited). Try again in ~10–30 seconds.`,
          ].join("\n")
        );
      }
    } catch (err) {
      console.error(err);
      try {
        await message.reply("Something went wrong while scanning. Try again in a bit.");
      } catch {}
    }
  });
});

// =====================
// Slash command handler
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /add_group (owner only)
  if (interaction.commandName === "add_group") {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: "Only the owner can use this command.", ephemeral: true });
      return;
    }

    const name = interaction.options.getString("name", true).trim();
    const link = interaction.options.getString("link", true).trim();
    const waitDays = interaction.options.getInteger("waitdays") ?? 14; // unused, kept for DB schema

    const groupId = extractGroupId(link);
    if (!groupId) {
      await interaction.reply({ content: "That doesn’t look like a valid Roblox group link.", ephemeral: true });
      return;
    }

    db = normalizeGroups(loadDB());
    db.groups = db.groups || [];

    // Replace if same groupId already exists
    const idx = db.groups.findIndex((g) => extractGroupId(g.link) === String(groupId));
    const entry = { name, link, waitDays };
    if (idx >= 0) db.groups[idx] = entry;
    else db.groups.push(entry);

    saveDB(db);

    await interaction.reply({ content: `✅ Saved group: **${name}**`, ephemeral: true });
    return;
  }

  // /eligible (embed + hyperlink group names) — ONLY in eligible channel
  if (interaction.commandName === "eligible") {
    if (interaction.channelId !== config.eligibleChannelId) {
      await interaction.reply({
        content: `You can only use /eligible in <#${config.eligibleChannelId}>.`,
        ephemeral: true,
      });
      return;
    }

    const username = interaction.options.getString("username", true).trim();
    await interaction.deferReply();

    let userId;
    try {
      userId = await usernameToUserId(username);
    } catch {
      await interaction.editReply("Roblox lookup failed. Try again in a bit.");
      return;
    }

    if (!userId) {
      await interaction.editReply(`I couldn’t find a Roblox user named **${username}**.`);
      return;
    }

    db = normalizeGroups(loadDB());
    const savedGroups = db.groups || [];
    if (!savedGroups.length) {
      await interaction.editReply("No groups are saved yet. Ask the owner to run /add_group.");
      return;
    }

    let ug;
    try {
      ug = await userGroups(userId);
    } catch {
      await interaction.editReply("Failed to fetch your groups from Roblox. Try again later.");
      return;
    }

    const userGroupIds = new Set((ug.data || []).map((x) => String(x.group?.id)));

    const desc = [];
    desc.push("‎ ‎ ‎ ‎ ‎ ‎  *am i in group?*");
    desc.push("");

    for (const g of savedGroups) {
      const gid = extractGroupId(g.link);
      const displayName = g.name ?? (gid ? `Group ${gid}` : "Group");
      const hyperlink = `[${displayName}](${g.link})`;

      const inGroup = gid && userGroupIds.has(String(gid));

      if (inGroup) desc.push(`﹒ ${hyperlink} : **Member**‎ ‎ 🟢`);
      else desc.push(`﹒ ${hyperlink} : **Not in Group**‎ ‎ 🔴`);
    }

    desc.push("");
    desc.push("‎");

    const embed = {
      color: 0xF8C8DC, // pastel pink
      title: `╰┈➤ ${username}  ˎˊ˗`,
      description: desc.join("\n"),
      footer: { text: " Membership Checker" },
    };

    await interaction.editReply({ embeds: [embed] });
  }
});

// =====================
// Boot
// =====================
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  await client.login(config.token);
})();