const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes, AttachmentBuilder
} = require('discord.js');
const https = require('https');
const http  = require('http');
const config = require('./challenge_config.json');
config.token = process.env.CHALLENGE_TOKEN || config.token || '';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─── Команды ──────────────────────────────────────────────────────────────────
const commands = [

  new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Опубликовать анонс челленджа вручную')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('title')      .setDescription('Заголовок, напр. «👊✨ Тема июня — Кунг-фу!»').setRequired(true))
    .addStringOption(o => o.setName('body')       .setDescription('Основной текст анонса').setRequired(true))
    .addStringOption(o => o.setName('outro')      .setDescription('Финальная фраза, напр. «Ждём ваши работы! ❤️»').setRequired(false))
    .addStringOption(o => o.setName('discord_url').setDescription('Ссылка на Discord-событие или канал').setRequired(false))
    .addAttachmentOption(o => o.setName('image')  .setDescription('Обложка челленджа').setRequired(false))
    .addStringOption(o => o.setName('image_url')  .setDescription('URL обложки (если нет файла)').setRequired(false))
    .addChannelOption(o => o.setName('channel')   .setDescription('Канал публикации (по умолчанию из config)').setRequired(false))
    .addStringOption(o => o.setName('mention')    .setDescription('Тег роли/пользователя, напр. @everyone').setRequired(false)),

  new SlashCommandBuilder()
    .setName('autochallenge')
    .setDescription('Подтянуть последний анонс челленджа из Telegram и опубликовать')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption(o => o.setName('image')  .setDescription('Обложка (если не загружена — берётся из Telegram)').setRequired(false))
    .addChannelOption(o => o.setName('channel')   .setDescription('Канал публикации (по умолчанию из config)').setRequired(false))
    .addStringOption(o => o.setName('mention')    .setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('challengeend')
    .setDescription('Объявить об окончании приёма работ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

].map(c => c.toJSON());

// ─── Регистрация ──────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('Регистрирую команды челленджа…');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Команды зарегистрированы ✓');
  } catch (e) { console.error('Ошибка регистрации:', e); }
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Парсинг Telegram ─────────────────────────────────────────────────────────
async function fetchTelegramChallengePost(channelHandle) {
  console.log(`[TG] Fetching t.me/s/${channelHandle}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}`);
  console.log(`[TG] Got ${html.length} bytes`);

  const postBlocks = [...html.matchAll(
    /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  )].map(m => m[0]);

  const keywords = ['челлендж', 'challenge', 'анимируем', 'тема месяца', 'тема июня', 'тема недели', 'анимировать'];
  const regex = new RegExp(keywords.join('|'), 'i');

  let targetPost = null;
  for (let i = postBlocks.length - 1; i >= 0; i--) {
    if (regex.test(postBlocks[i])) {
      targetPost = postBlocks[i];
      break;
    }
  }

  if (!targetPost) throw new Error('Пост про челлендж не найден');

  // Текст только из блока сообщения
  let textRaw = '';
  const msgTextMatch = targetPost.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (msgTextMatch) {
    textRaw = msgTextMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
      .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Картинка из фото-блока поста
  let imageUrl = null;
  const photoWrapMatch = targetPost.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoWrapMatch) imageUrl = photoWrapMatch[1];
  if (!imageUrl) {
    const bgMatches = [...targetPost.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) {
        imageUrl = m[1]; break;
      }
    }
  }

  // Discord ссылка
  const discordMatch = targetPost.match(/href="(https?:\/\/discord\.(?:gg|com)[^"]+)"/);

  console.log(`[TG] Image: ${imageUrl}`);

  return {
    text: textRaw,
    imageUrl: imageUrl || null,
    discordUrl: discordMatch ? discordMatch[1] : null,
  };
}

// ─── Форматирование анонса челленджа ──────────────────────────────────────────
// Формат как на скриншоте: жирный заголовок, текст, ссылки
function buildChallengeText({ title, body, outro, discordUrl, mention, roleMention }) {
  let text = '';

  if (mention) {
    text += `${mention}\n`;
  } else if (roleMention) {
    text += `-# ${roleMention}\n`;
  }

  text += `**${title}**\n`;

  if (body) text += `\n${body}\n`;
  if (outro) text += `\n${outro}\n`;
  if (discordUrl) text += `\n${discordUrl}`;

  return text;
}

// ─── Отправка с картинкой ─────────────────────────────────────────────────────
async function sendAnnouncement(channel, text, imageUrl) {
  if (!imageUrl) {
    await channel.send({ content: text });
    return;
  }
  try {
    if (imageUrl.includes('cdn.discordapp.com') || imageUrl.includes('media.discordapp.net')) {
      await channel.send({ content: text, files: [{ attachment: imageUrl, name: 'challenge.jpg' }] });
    } else {
      const buffer = await fetchImageBuffer(imageUrl);
      const attachment = new AttachmentBuilder(buffer, { name: 'challenge.jpg' });
      await channel.send({ content: text, files: [attachment] });
    }
  } catch (e) {
    console.warn('[IMG] Ошибка картинки:', e.message);
    await channel.send({ content: text });
  }
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Бот челленджей запущен как ${client.user.tag}`);
  await registerCommands();
});

// ─── Команды ──────────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /challenge ────────────────────────────────────────────────────────────────
  if (commandName === 'challenge') {
    const title      = interaction.options.getString('title');
    const body       = interaction.options.getString('body');
    const outro      = interaction.options.getString('outro') || '';
    const discordUrl = interaction.options.getString('discord_url') || '';
    let   imageUrl   = interaction.options.getString('image_url') || '';
    const attached   = interaction.options.getAttachment('image');
    let   mention    = interaction.options.getString('mention') || '';

    await interaction.deferReply({ ephemeral: true });

    if (attached) imageUrl = attached.url;
    if (!imageUrl) {
      try {
        const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
        const tg = await fetchTelegramChallengePost(tgHandle);
        if (tg.imageUrl) imageUrl = tg.imageUrl;
      } catch (e) {
        console.warn('[TG] Обложка не найдена:', e.message);
      }
    }

    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    const text = buildChallengeText({
      title, body, outro, discordUrl, mention,
      roleMention: mention ? null : (config.challengeRoleMention || null)
    });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');

    await sendAnnouncement(targetChannel, text, imageUrl);
    await interaction.editReply(`✅ Анонс челленджа опубликован в <#${targetChannel.id}>!`);
  }

  // ── /autochallenge ────────────────────────────────────────────────────────────
  if (commandName === 'autochallenge') {
    await interaction.deferReply({ ephemeral: true });

    const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
    let tg;
    try {
      tg = await fetchTelegramChallengePost(tgHandle);
    } catch (e) {
      return interaction.editReply(`❌ Не удалось распарсить Telegram: ${e.message}`);
    }

    const attached = interaction.options.getAttachment('image');
    if (attached) tg.imageUrl = attached.url;

    let mention = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    // Разбиваем текст: первая строка — заголовок, остальное — тело
    const allLines = tg.text.split('\n');
    const title = allLines[0]?.trim() || '';
    const body  = allLines.slice(1).join('\n').trim();

    const text = buildChallengeText({
      title, body,
      discordUrl: tg.discordUrl || '',
      mention,
      roleMention: mention ? null : (config.challengeRoleMention || null)
    });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');

    await sendAnnouncement(targetChannel, text, tg.imageUrl);
    await interaction.editReply(`✅ Автоанонс челленджа опубликован в <#${targetChannel.id}>!`);
  }

  // ── /challengeend ─────────────────────────────────────────────────────────────
  if (commandName === 'challengeend') {
    const channel = client.channels.cache.get(config.announceChannelId);
    if (!channel) return interaction.reply({ content: '❌ Канал не найден.', ephemeral: true });

    const roleMention = config.challengeRoleMention || '';
    await channel.send(
      (roleMention ? `-# ${roleMention}\n` : '') +
      `## ⏰ Приём работ завершён!\n` +
      `Спасибо всем участникам — ждём ваши анимации! Результаты объявим совсем скоро 🎉`
    );
    await interaction.reply({ content: '✅ Отправлено.', ephemeral: true });
  }
});

client.login(config.token);
