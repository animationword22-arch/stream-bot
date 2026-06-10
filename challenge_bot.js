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
    .setName('autochallenge')
    .setDescription('Анонс челленджа из Telegram (анимация)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption(o => o.setName('image')    .setDescription('Обложка (если не загружена — берётся из Telegram)').setRequired(false))
    .addStringOption(o => o.setName('event_url')    .setDescription('Ссылка на событие Discord').setRequired(false))
    .addChannelOption(o => o.setName('channel')     .setDescription('Канал публикации').setRequired(false))
    .addStringOption(o => o.setName('mention')      .setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('autosketching')
    .setDescription('Анонс скетчинга из Telegram')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('topic')        .setDescription('Тема занятия, напр. «раскадровка»').setRequired(true))
    .addStringOption(o => o.setName('time')         .setDescription('Время по мск, напр. «17:00»').setRequired(false))
    .addStringOption(o => o.setName('event_url')    .setDescription('Ссылка на событие Discord').setRequired(false))
    .addAttachmentOption(o => o.setName('image')    .setDescription('Обложка').setRequired(false))
    .addChannelOption(o => o.setName('channel')     .setDescription('Канал публикации').setRequired(false))
    .addStringOption(o => o.setName('mention')      .setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Ручной анонс челленджа')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('title')        .setDescription('Заголовок').setRequired(true))
    .addStringOption(o => o.setName('body')         .setDescription('Основной текст').setRequired(true))
    .addStringOption(o => o.setName('discord_url')  .setDescription('Ссылка на событие Discord').setRequired(false))
    .addAttachmentOption(o => o.setName('image')    .setDescription('Обложка').setRequired(false))
    .addStringOption(o => o.setName('image_url')    .setDescription('URL обложки').setRequired(false))
    .addChannelOption(o => o.setName('channel')     .setDescription('Канал публикации').setRequired(false))
    .addStringOption(o => o.setName('mention')      .setDescription('Тег роли/пользователя').setRequired(false)),

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

// ─── HTTP ─────────────────────────────────────────────────────────────────────
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
async function fetchTelegramPost(channelHandle, keywords) {
  console.log(`[TG] Fetching t.me/s/${channelHandle}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}`);
  console.log(`[TG] Got ${html.length} bytes`);

  const postBlocks = [...html.matchAll(
    /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  )].map(m => m[0]);

  const regex = new RegExp(keywords.join('|'), 'i');
  let targetPost = null;
  for (let i = postBlocks.length - 1; i >= 0; i--) {
    if (regex.test(postBlocks[i])) { targetPost = postBlocks[i]; break; }
  }
  if (!targetPost) throw new Error('Пост не найден');

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

  let imageUrl = null;
  const photoWrapMatch = targetPost.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoWrapMatch) imageUrl = photoWrapMatch[1];
  if (!imageUrl) {
    const bgMatches = [...targetPost.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) { imageUrl = m[1]; break; }
    }
  }

  const discordMatch = targetPost.match(/href="(https?:\/\/discord\.(?:gg|com)[^"]+)"/);
  console.log(`[TG] Image: ${imageUrl}`);

  return { text: textRaw, imageUrl: imageUrl || null, discordUrl: discordMatch ? discordMatch[1] : null };
}

// ─── Форматирование: ЧЕЛЛЕНДЖ ─────────────────────────────────────────────────
function buildChallengeText({ title, body, discordUrl, mention, roleMention }) {
  let text = '';
  if (mention) text += `${mention}\n`;
  else if (roleMention) text += `${roleMention}\n`;
  if (title) text += `# ${title}\n`;
  if (body) text += body;
  if (discordUrl) text += `\n\n-# *Не забудьте подписаться на событие в Discord, чтобы вовремя получить оповещение о начале челленджа!*\n-# ${discordUrl}`;
  return text.trim();
}

// ─── Форматирование: СКЕТЧИНГ ─────────────────────────────────────────────────
function buildSketchingText({ topic, time, discordUrl, sketchChannelId, telegramUrl, mention, roleMention }) {
  const t = time || '17:00';
  const sketchChannel = sketchChannelId ? `<#${sketchChannelId}>` : '#sketching-sessions-chat';
  const tgLink = telegramUrl || 'https://t.me/animationclub_challange';

  let text = '';
  if (mention) text += `-# ${mention}\n`;
  else if (roleMention) text += `-# ${roleMention}\n`;

  text += `# Присоединяйтесь к Live Sketching Sessions! Сегодня мы в ${t} по мск будем ${topic}! 🎨\n`;
  text += `Каждую субботу в ${t} по московскому времени, мы проводим практики по рисованию, в Discord и Telegram!\n\n`;
  text += `Нужно будет рисовать наброски или анатомию в любых техниках, в которых захотите. Референсы для рисования будут в ${sketchChannel}, туда же можно выкладывать свои работы. Или под соответствующим постом в [телеграме](${tgLink}) в комментариях!`;

  if (discordUrl) {
    text += `\n\n-# *Не забудьте подписаться на событие в Discord, чтобы вовремя получить оповещение о начале челленджа!*\n-# ${discordUrl}`;
  }

  return text.trim();
}

// ─── Отправка ─────────────────────────────────────────────────────────────────
async function sendAnnouncement(channel, text, imageUrl) {
  if (!imageUrl) { await channel.send({ content: text }); return; }
  try {
    if (imageUrl.includes('cdn.discordapp.com') || imageUrl.includes('media.discordapp.net')) {
      await channel.send({ content: text, files: [{ attachment: imageUrl, name: 'cover.jpg' }] });
    } else {
      const buffer = await fetchImageBuffer(imageUrl);
      const attachment = new AttachmentBuilder(buffer, { name: 'cover.jpg' });
      await channel.send({ content: text, files: [attachment] });
    }
  } catch (e) {
    console.warn('[IMG] Ошибка:', e.message);
    await channel.send({ content: text });
  }
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  await registerCommands();
});

// ─── Команды ──────────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /autochallenge ────────────────────────────────────────────────────────────
  if (commandName === 'autochallenge') {
    await interaction.deferReply({ ephemeral: true });

    const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
    let tg;
    try {
      tg = await fetchTelegramPost(tgHandle, ['челлендж', 'challenge', 'тема', 'анимируем', 'присоединяйтесь', 'присылайте']);
    } catch (e) {
      return interaction.editReply(`❌ Не удалось распарсить Telegram: ${e.message}`);
    }

    const attached = interaction.options.getAttachment('image');
    if (attached) tg.imageUrl = attached.url;
    const eventUrl = interaction.options.getString('event_url') || '';
    if (eventUrl) tg.discordUrl = eventUrl;

    let mention = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    const allLines = tg.text.split('\n');
    const title = allLines[0]?.trim() || '';
    const body  = allLines.slice(1).join('\n').trim();

    const bodyLines = body.split('\n').filter(l => {
      const t = l.trim();
      if (t.startsWith('https://discord.com/events')) return false;
      if (/^(youtube|vk видео|ютуб)/i.test(t)) return false;
      if (/^youtube\s*\|\s*vk/i.test(t)) return false;
      return true;
    });
    let firstBodyLine = true;
    const cleanBody = bodyLines.map(l => {
      if (firstBodyLine && l.trim()) { firstBodyLine = false; return `## ${l.trim()}`; }
      return l;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    const text = buildChallengeText({
      title, body: cleanBody,
      discordUrl: tg.discordUrl || '',
      mention,
      roleMention: mention ? null : (config.challengeRoleMention || null)
    });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(targetChannel, text, tg.imageUrl);
    await interaction.editReply(`✅ Анонс челленджа опубликован в <#${targetChannel.id}>!`);
  }

  // ── /autosketching ────────────────────────────────────────────────────────────
  if (commandName === 'autosketching') {
    await interaction.deferReply({ ephemeral: true });

    const topic    = interaction.options.getString('topic');
    const time     = interaction.options.getString('time') || '17:00';
    const eventUrl = interaction.options.getString('event_url') || '';
    const attached = interaction.options.getAttachment('image');
    let   mention  = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    // Пробуем подтянуть картинку из Telegram если не приложена
    let imageUrl = attached ? attached.url : null;
    if (!imageUrl) {
      try {
        const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
        const tg = await fetchTelegramPost(tgHandle, ['скетчинг', 'sketching', 'персонаж', 'рисовать', 'наброски', 'live sketching']);
        if (tg.imageUrl) imageUrl = tg.imageUrl;
      } catch (e) {
        console.warn('[TG] Обложка скетчинга не найдена:', e.message);
      }
    }

    const text = buildSketchingText({
      topic, time,
      discordUrl:     eventUrl || config.sketchingEventUrl || '',
      sketchChannelId: config.sketchingChannelId || '',
      telegramUrl:    config.telegramChannel || 'https://t.me/animationclub_challange',
      mention,
      roleMention: mention ? null : (config.sketchingRoleMention || config.challengeRoleMention || null)
    });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.sketchingAnnounceChannelId || config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(targetChannel, text, imageUrl);
    await interaction.editReply(`✅ Анонс скетчинга опубликован в <#${targetChannel.id}>!`);
  }

  // ── /challenge ────────────────────────────────────────────────────────────────
  if (commandName === 'challenge') {
    const title      = interaction.options.getString('title');
    const body       = interaction.options.getString('body');
    const discordUrl = interaction.options.getString('discord_url') || '';
    let   imageUrl   = interaction.options.getString('image_url') || '';
    const attached   = interaction.options.getAttachment('image');
    let   mention    = interaction.options.getString('mention') || '';

    await interaction.deferReply({ ephemeral: true });

    if (attached) imageUrl = attached.url;
    if (!imageUrl) {
      try {
        const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
        const tg = await fetchTelegramPost(tgHandle, ['челлендж', 'тема', 'анимируем']);
        if (tg.imageUrl) imageUrl = tg.imageUrl;
      } catch (e) { console.warn('[TG] Обложка не найдена:', e.message); }
    }

    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    const text = buildChallengeText({
      title, body, discordUrl, mention,
      roleMention: mention ? null : (config.challengeRoleMention || null)
    });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(targetChannel, text, imageUrl);
    await interaction.editReply(`✅ Анонс опубликован в <#${targetChannel.id}>!`);
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
