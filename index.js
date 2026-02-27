// index.js (RAILWAY SAFE + SCAN FEATURE KEPT)
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

// ---------------------
// Config loader
// - Uses ENV on Railway
// - Falls back to local config.json if it exists (for local dev)
// ---------------------
let fileConfig = {};
try {
  fileConfig = require("./config.json"); // optional local file
} catch {
  fileConfig = {};
}

function mustGet(key, envKey = key) {
  const v = process.env[envKey] ?? fileConfig[key];
  return v && String(v).trim() ? String(v).trim() : null;
}

const config = {
  token: mustGet("token", "DISCORD_TOKEN"),
  clientId: mustGet("clientId", "CLIENT_ID"),
  ownerId: mustGet("ownerId", "OWNER_ID"),
  scanChannelId: mustGet("scanChannelId", "SCAN_CHANNEL_ID"),
  eligibleChannelId: mustGet("eligibleChannelId", "ELIGIBLE_CHANNEL_ID"),
};

const missing = Object.entries(config)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(
    `❌ Missing config values: ${missing.join(", ")}\n` +
      `Set these in Railway Variables:\n` +
      `DISCORD_TOKEN, CLIENT_ID, OWNER_ID, SCAN_CHANNEL_ID, ELIGIBLE_CHANNEL_ID\n` +
      `(ROBLOSECURITY optional for regional pricing detection)`
  );
  process.exit(1);
}

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
        waitDays: Number.isFinite(Number(g?.waitDays))
          ? Number(g.waitDays)
          : 14,
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

// ✅ NEW: extract ALL game pass IDs in the replied message
function extractGamePassIds(text) {
  if (!text) return [];
  const matches = [...String(text).matchAll(/roblox\.com\/game-pass\/(\d+)/gi)];
  const ids = matches.map((m) => m[1]);
  // unique
  return [...new Set(ids)];
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
  const cookie = process.env.ROBLOSECURITY; // optional
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

  if (!res.ok)
    throw new Error(`Failed to fetch gamepass details (${res.status})`);
  return res.json();
}

function hasRegionalPricing(details) {
  const pi = details?.priceInformation;
  if (!pi) return false;

  if (pi.isInActivePriceOptimizationExperiment === true) return true;
  if (pi.isInPriceOptimizationExperiment === true) return true;
  if (pi.isPriceOptimized === true) return true;

  const enabled = Array.isArray(pi.enabledFeatures)
    ? pi.enabledFeatures.map(String)
    : [];

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
        o
          .setName("name")
          .setDescription("Display name (e.g., Nexus Arc)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("link").setDescription("Roblox group link").setRequired(true)
      )
      .addIntegerOption((o) =>
        o
          .setName("waitdays")
          .setDescription("Unused for now (default 14)")
          .setRequired(false)
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
// Scan throttling + queue
// =====================
const scanCooldown = new Map();
const COOLDOWN_MS = 5000;
let scanQueue = Promise.resolve();

function enqueueScan(task) {
  scanQueue = scanQueue.then(task).catch((e) => console.error("Scan task failed:", e));
  return scanQueue;
}

// =====================
// Message-based scan (reply "scan" to a message that has one or more links)
// =====================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== config.scanChannelId) return;
  if (message.content.trim().toLowerCase() !== "scan") return;
  if (!message.reference?.messageId) return;

  const now = Date.now();
  const last = scanCooldown.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) {
    await message.reply("⏳ Slow down a bit—Roblox rate limits fast.\nTry again in a few seconds.");
    return;
  }
  scanCooldown.set(message.author.id, now);

  enqueueScan(async () => {
    try {
      const replied = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      if (!replied) return;

      // ✅ get ALL game pass ids from the replied message
      const ids = extractGamePassIds(replied.content);

      if (!ids.length) {
        await message.reply("I couldn’t find any Roblox gamepass links in the replied message.");
        return;
      }

      const blocks = [];
      let i = 1;

      for (const gpId of ids) {
        const link = `https://www.roblox.com/game-pass/${gpId}`;

        try {
          const info = await fetchGamePassInfo(gpId);
          const price = Number(info.PriceInRobux ?? info.priceInRobux ?? info.price ?? 0);

          if (!price) {
            blocks.push(`${i}. ${link}\nPrice: (couldn’t read)\n`);
            i++;
            continue;
          }

          const receive = robuxAfterFee(price);

          // Optional regional pricing detection
          let details = null;
          let regionalOn = false;

          try {
            details = await fetchGamePassDetails(gpId);
            regionalOn = details ? hasRegionalPricing(details) : false;
          } catch (e) {
            details = null;
            regionalOn = false;
          }

          if (details && regionalOn) {
            blocks.push(
              `${i}. ${link}\nPrice: **${price}**\n⚠️ Regional pricing detected\n`
            );
          } else if (details && !regionalOn) {
            blocks.push(
              `${i}. ${link}\nPrice: **${price}**\nYou will receive: **${receive}** robux\n`
            );
          } else {
            blocks.push(
              `${i}. ${link}\nPrice: **${price}**\nYou will receive: **${receive}** robux\n⚠️ Couldn’t check regional pricing right now (rate limited).\nTry again in ~10–30 seconds.\n`
            );
          }
        } catch (e) {
          blocks.push(`${i}. ${link}\n❌ Failed to scan (${e?.message ?? "error"})\n`);
        }

        i++;
        // small delay to reduce 429
        await sleep(350);
      }

      // Discord message limit ~2000 chars, so chunk replies
      const chunks = [];
      let buf = "";
      for (const b of blocks) {
        if ((buf + b + "\n").length > 1800) {
          chunks.push(buf);
          buf = "";
        }
        buf += b + "\n";
      }
      if (buf.trim()) chunks.push(buf);

      for (const c of chunks) {
        await message.reply(c.trim());
      }
    } catch (err) {
      console.error(err);
      try {
        await message.reply("Something went wrong while scanning.\nTry again in a bit.");
      } catch {}
    }
  });
});

// =====================
// Slash command handler
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "add_group") {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({
        content: "Only the owner can use this command.",
        ephemeral: true,
      });
      return;
    }

    const name = interaction.options.getString("name", true).trim();
    const link = interaction.options.getString("link", true).trim();
    const waitDays = interaction.options.getInteger("waitdays") ?? 14;

    const groupId = extractGroupId(link);
    if (!groupId) {
      await interaction.reply({
        content: "That doesn’t look like a valid Roblox group link.",
        ephemeral: true,
      });
      return;
    }

    db = normalizeGroups(loadDB());
    db.groups = db.groups || [];

    const idx = db.groups.findIndex((g) => extractGroupId(g.link) === String(groupId));
    const entry = { name, link, waitDays };

    if (idx >= 0) db.groups[idx] = entry;
    else db.groups.push(entry);

    saveDB(db);

    await interaction.reply({
      content: `✅ Saved group: **${name}**`,
      ephemeral: true,
    });
    return;
  }

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
      await interaction.editReply("Roblox lookup failed.\nTry again in a bit.");
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
      await interaction.editReply("Failed to fetch your groups from Roblox.\nTry again later.");
      return;
    }

    const userGroupIds = new Set((ug.data || []).map((x) => String(x.group?.id)));

    const desc = [];
    desc.push("‎ ‎ ‎ ‎ ‎ ‎ *am i in group?*");
    desc.push("");

    for (const g of savedGroups) {
      const gid = extractGroupId(g.link);
      const displayName = g.name ?? (gid ? `Group ${gid}` : "Group");
      const hyperlink = `[${displayName}](${g.link})`;
      const inGroup = gid && userGroupIds.has(String(gid));
      if (inGroup) desc.push(`﹒ ${hyperlink} : **Member**‎ ‎ `);
      else desc.push(`﹒ ${hyperlink} : **Not in Group**‎ ‎ `);
    }

    desc.push("");
    desc.push("‎");

    const embed = {
      color: 0xf8c8dc,
      title: `╰┈➤ ${username} ˎˊ˗`,
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
