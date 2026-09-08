"use strict";

const { Client, GatewayIntentBits } = require("discord.js");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_ADDR_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

function findSolAddress(text) {
  return (String(text || "").match(SOL_ADDR_IN_TEXT) || []).find((value) => SOL_ADDR.test(value)) || null;
}

function short(address) {
  return `${String(address).slice(0, 4)}…${String(address).slice(-4)}`;
}

async function handlePriorityMessage(message, { store, onQueued = null, env = process.env } = {}) {
  if (!store || typeof store.enqueuePriorityToken !== "function") {
    throw new Error("recurrence store with enqueuePriorityToken is required");
  }
  if (message?.author?.bot) return { handled: false, reason: "bot" };

  const channelId = String(env.DISCORD_CHANNEL_ID || "").trim();
  if (channelId && String(message?.channelId || "") !== channelId) {
    return { handled: false, reason: "wrong-channel" };
  }

  const address = findSolAddress(message?.content);
  if (!address) return { handled: false, reason: "no-token" };

  const queued = store.enqueuePriorityToken(address, { source: "discord" });
  if (typeof message?.reply === "function") {
    await message.reply(`⚡ ${short(address)} queued for priority trader scan.`).catch(() => {});
  }
  if (typeof onQueued === "function") {
    queueMicrotask(() => Promise.resolve(onQueued()).catch((error) => {
      console.warn(`[discord-priority] immediate scan trigger failed: ${String(error?.message || error).slice(0, 300)}`);
    }));
  }
  return { handled: true, address, ...queued };
}

function startDiscordPriorityIntake({ store, onQueued = null, env = process.env, clientFactory = null } = {}) {
  const token = String(env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) {
    console.log("[discord-priority] disabled: no Discord token configured");
    return null;
  }

  const factory = clientFactory || (() => new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  }));
  const client = factory();
  client.on("messageCreate", (message) => {
    handlePriorityMessage(message, { store, onQueued, env }).catch((error) => {
      console.warn(`[discord-priority] message handling failed: ${String(error?.message || error).slice(0, 500)}`);
    });
  });
  client.once("ready", () => {
    console.log(`[discord-priority] logged in as ${client.user?.tag || "Discord bot"}`);
  });
  client.login(token).catch((error) => {
    console.warn(`[discord-priority] login failed: ${String(error?.message || error).slice(0, 500)}`);
  });
  return client;
}

module.exports = {
  findSolAddress,
  handlePriorityMessage,
  startDiscordPriorityIntake,
};
