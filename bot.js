const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes, AttachmentBuilder
} = require('discord.js');
const https = require('https');
const http  = require('http');
const config = require('./config.json');
// Токен берётся из переменной окружения Railway (TOKEN), config.json его не содержит
config.token = process.env.TOKEN || config.token || '';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─── Slash-команды ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Опубликовать анонс стрима в канал')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('title')       .setDescription('Заголовок / тема стрима').setRequired(true))
    .addStringOption(o => o.setName('speaker')      .setDescription('Имя спикера').setRequired(true))
    .addStringOption(o => o.setName('speaker_role') .setDescription('Роль / должность спикера').setRequired(false))
    .addStringOption(o => o.setName('points')       .setDescription('Пункты программы через ; ').setRequired(false))
    .addStringOption(o => o.setName('outro')        .setDescription('Финальная фраза + дата/время').setRequired(false))
    .addStringOption(o => o.setName('youtube_url')  .setDescription('Ссылка YouTube').setRequired(false))
    .addStringOption(o => o.setName('vk_url')       .setDescription('Ссылка VK Видео').setRequired(false))
    .addStringOption(o => o.setName('image_url')    .setDescription('URL обложки (если не заполнено — берётся из Telegram)').setRequired(false))
    .addAttachmentOption(o => o.setName('image')    .setDescription('Загрузить обложку напрямую (приоритет над URL и Telegram)').setRequired(false))
    .addChannelOption(o => o.setName('channel')     .setDescription('Канал для публикации (по умолчанию — основной из config)').setRequired(false))
    .addStringOption(o => o.setName('mention')      .setDescription('Тег роли или пользователя, напр. @everyone или <@&123456>').setRequired(false)),

  new SlashCommandBuilder()
    .setName('autoannounce')
    .setDescription('Подтянуть анонс стрима из Telegram и опубликовать')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('post_url').setDescription('Ссылка на пост в Telegram, напр. https://t.me/animationschool_ru/18015').setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Обложка стрима (если не загружена — берётся из Telegram)').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Канал для публикации').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Тег роли или пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('streamend')
    .setDescription('Объявить об окончании стрима')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Показать расписание стримов'),
].map(c => c.toJSON());

// ─── Регистрация ──────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('Регистрирую slash-команды…');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Команды зарегистрированы ✓');
  } catch (e) { console.error('Ошибка регистрации:', e); }
}

// ─── Форматирование текста анонса ─────────────────────────────────────────────
function buildAnnouncement({ title, speaker, speakerRole, points, outro, youtubeUrl, vkUrl }) {
  const roleMention = config.streamRoleMention || '@Stream Events';

  let text = `-# ${roleMention}\n`;
  text += `# ${title} 🧐\n`;

  if (speaker) {
    const roleStr = speakerRole ? `, ${speakerRole}` : '';
    text += `**${speaker}**${roleStr} покажет на практике — следи за анонсом.\n`;
  }

  if (points && points.length) {
    text += `\nЧто будет на стриме:\n`;
    text += points.map(p => `— ${p.trim()}`).join('\n') + '\n';
  }

  if (outro) text += `\n${outro}\n`;

  const links = [];
  if (youtubeUrl) links.push(`**[YouTube](${youtubeUrl})**`);
  if (vkUrl)      links.push(`**[VK Видео](${vkUrl})**`);
  if (links.length) text += `\n${links.join(' | ')}`;

  return text;
}

// ─── HTTP fetch (текст) ───────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StreamBot/1.0)',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Скачать картинку как Buffer ──────────────────────────────────────────────
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamBot/1.0)' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Парсинг Telegram-канала ──────────────────────────────────────────────────
async function fetchTelegramStreamPost(channelHandle) {
  // Загружаем 3 страницы (~60 постов)
  let allBlocks = [];
  let beforeId = '';
  for (let page = 0; page < 3; page++) {
    const url = beforeId
      ? `https://t.me/s/${channelHandle}?before=${beforeId}`
      : `https://t.me/s/${channelHandle}`;
    console.log(`[TG] Fetching page ${page + 1}: ${url}`);
    const html = await fetchUrl(url);
    console.log(`[TG] Got ${html.length} bytes`);
    const blocks = [...html.matchAll(
      /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
    )].map(m => m[0]);
    if (!blocks.length) break;
    allBlocks = [...blocks, ...allBlocks];
    const ids = [...html.matchAll(/data-post="[^/]+\/(\d+)"/g)].map(m => parseInt(m[1]));
    if (!ids.length) break;
    beforeId = Math.min(...ids).toString();
  }

  if (!allBlocks.length) throw new Error('Посты не найдены');

  // Берём последний пост с картинкой
  let targetPost = null;
  for (let i = allBlocks.length - 1; i >= 0; i--) {
    if (allBlocks[i].includes('tgme_widget_message_photo_wrap')) { targetPost = allBlocks[i]; break; }
  }
  if (!targetPost) targetPost = allBlocks[allBlocks.length - 1];

  // Картинка — ищем только в блоке фото поста (tgme_widget_message_photo_wrap)
  let imageUrl = null;
  const photoWrapMatch = targetPost.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoWrapMatch) {
    imageUrl = photoWrapMatch[1];
  }
  // Запасной вариант — любой background-image из блока с cdn4/cdn5 (не youtube/vk)
  if (!imageUrl) {
    const bgMatches = [...targetPost.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) {
        imageUrl = m[1];
        break;
      }
    }
  }

  console.log(`[TG] Image URL: ${imageUrl}`);

  // Берём только текст сообщения из tgme_widget_message_text
  let textRaw = '';
  const msgTextMatch = targetPost.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (msgTextMatch) {
    textRaw = msgTextMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '$2') // убираем ссылки, оставляем текст
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n') // убираем лишние пустые строки
      .trim();
  }

  const ytMatch = targetPost.match(/href="(https?:\/\/(?:www\.)?youtube[^"]+)"/);
  const vkMatch = targetPost.match(/href="(https?:\/\/(?:www\.)?vkvideo[^"]+|https?:\/\/vk\.com\/video[^"]+)"/);

  return {
    text: textRaw,
    imageUrl: imageUrl || null,
    youtubeUrl: ytMatch ? ytMatch[1] : null,
    vkUrl: vkMatch ? vkMatch[1] : null,
  };
}

// ─── Парсинг конкретного поста Telegram по ID ────────────────────────────────
async function fetchTelegramPostById(channelHandle, postId) {
  console.log(`[TG] Fetching post ${postId}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}?before=${parseInt(postId) + 1}`);
  const postBlocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
  const target = postBlocks.find(p => p.includes(`/${channelHandle}/${postId}`)) || postBlocks[postBlocks.length - 1];
  if (!target) throw new Error('Пост не найден');

  // Берём все текстовые блоки — выбираем самый длинный (основной текст)
  const allTextMatches = [...target.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  const allTexts = allTextMatches.map(m =>
    m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
      .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  ).filter(Boolean);
  const textRaw = allTexts.length ? allTexts.reduce((a, b) => a.length >= b.length ? a : b, '') : '';

  let imageUrl = null;
  const photoMatch = target.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoMatch) imageUrl = photoMatch[1];
  if (!imageUrl) {
    const bgMatches = [...target.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) { imageUrl = m[1]; break; }
    }
  }

  const ytMatch = target.match(/href="(https?:\/\/(?:www\.)?youtube[^"]+)"/);
  const vkMatch = target.match(/href="(https?:\/\/(?:www\.)?vkvideo[^"]+|https?:\/\/vk\.com\/video[^"]+)"/);

  return { text: textRaw, imageUrl: imageUrl || null, youtubeUrl: ytMatch ? ytMatch[1] : null, vkUrl: vkMatch ? vkMatch[1] : null };
}

// ─── Парсинг YouTube RSS ──────────────────────────────────────────────────────
async function fetchLatestYoutubeStream(channelHandle) {
  const pageHtml = await fetchUrl(`https://www.youtube.com/${channelHandle}`);
  const cidMatch = pageHtml.match(/"channelId":"(UC[^"]+)"/);
  if (!cidMatch) throw new Error('Не удалось найти channelId');
  const channelId = cidMatch[1];
  const rss = await fetchUrl(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  const entries = [...rss.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  if (!entries.length) throw new Error('RSS пустой');
  const entry = entries[0][1];
  const videoUrl = (entry.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || '';
  return { videoUrl };
}

// ─── Отправить анонс с картинкой-вложением ────────────────────────────────────
async function sendAnnouncement(channel, text, imageUrl) {
  if (!imageUrl) {
    await channel.send({ content: text });
    return;
  }
  try {
    // Если это уже Discord CDN — отправляем напрямую по URL (без скачивания, оригинальное качество)
    if (imageUrl.includes('cdn.discordapp.com') || imageUrl.includes('media.discordapp.net')) {
      await channel.send({ content: text, files: [{ attachment: imageUrl, name: 'cover.jpg' }] });
    } else {
      // Для Telegram и других источников — скачиваем и прикрепляем
      const buffer = await fetchImageBuffer(imageUrl);
      const attachment = new AttachmentBuilder(buffer, { name: 'cover.jpg' });
      await channel.send({ content: text, files: [attachment] });
    }
  } catch (e) {
    console.warn('[IMG] Не удалось отправить с картинкой:', e.message);
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

  // ── /announce ────────────────────────────────────────────────────────────────
  if (commandName === 'announce') {
    const title       = interaction.options.getString('title');
    const speaker     = interaction.options.getString('speaker');
    const speakerRole = interaction.options.getString('speaker_role') || '';
    const pointsRaw   = interaction.options.getString('points') || '';
    const outro       = interaction.options.getString('outro') || '';
    const youtubeUrl  = interaction.options.getString('youtube_url') || '';
    const vkUrl       = interaction.options.getString('vk_url') || '';
    let   imageUrl    = interaction.options.getString('image_url') || '';

    await interaction.deferReply({ ephemeral: true });

    // Приоритет: прикреплённый файл > image_url > Telegram
    const attachedImage = interaction.options.getAttachment('image');
    if (attachedImage) {
      imageUrl = attachedImage.url;
    } else if (!imageUrl) {
      try {
        const tgHandle = (config.telegramChannel || 'https://t.me/animationschool_ru')
          .replace(/^https?:\/\/t\.me\//, '');
        const tg = await fetchTelegramStreamPost(tgHandle);
        if (tg.imageUrl) imageUrl = tg.imageUrl;
      } catch (e) {
        console.warn('[TG] Не удалось подтянуть обложку:', e.message);
      }
    }

    const points = pointsRaw ? pointsRaw.split(';').filter(Boolean) : [];
    const text   = buildAnnouncement({ title, speaker, speakerRole, points, outro, youtubeUrl, vkUrl });

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');

    let mention = interaction.options.getString('mention') || '';
    // Если передали просто ID — оборачиваем в тег роли
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;
    // Если mention указан — убираем @Stream Events из текста (он уже есть как -#)
    let finalText = text;
    if (mention) {
      finalText = mention + '\n' + text.replace(/^-# [^\n]+\n/, '');
    }
    await sendAnnouncement(targetChannel, finalText, imageUrl);
    await interaction.editReply(`✅ Анонс опубликован в <#${targetChannel.id}>!`);
  }

  // ── /autoannounce ─────────────────────────────────────────────────────────────
  if (commandName === 'autoannounce') {
    await interaction.deferReply({ ephemeral: true });

    const postUrlRaw = interaction.options.getString('post_url') || '';
    const tgHandle = (config.telegramChannel || 'https://t.me/animationschool_ru')
      .replace(/^https?:\/\/t\.me\//, '');
    const postIdMatch = postUrlRaw.match(/(\d+)$/);
    const postId = postIdMatch ? postIdMatch[1] : '';

    let tg;
    try {
      tg = await fetchTelegramStreamPost(tgHandle);
    } catch (e) {
      return interaction.editReply(`❌ Не удалось распарсить Telegram: ${e.message}`);
    }

    // Если прикреплена картинка — используем её вместо Telegram
    const attachedImage = interaction.options.getAttachment('image');
    if (attachedImage) tg.imageUrl = attachedImage.url;

    let youtubeUrl = tg.youtubeUrl || '';
    if (!youtubeUrl && config.youtubeChannelHandle) {
      try {
        const yt = await fetchLatestYoutubeStream(config.youtubeChannelHandle);
        youtubeUrl = yt.videoUrl;
      } catch (e) {
        console.warn('YouTube RSS недоступен:', e.message);
      }
    }

    const roleMention = config.streamRoleMention || '@Stream Events';

    // Текст как есть из Telegram
    const cleanText = tg.text
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Первая непустая строка — заголовок #
    const textLines = cleanText.split('\n');
    let firstLine = true;
    const formattedText = textLines.map(l => {
      if (firstLine && l.trim()) { firstLine = false; return `# ${l.trim()}`; }
      return l;
    }).join('\n');

    let text = `-# ${roleMention}\n`;
    if (formattedText) text += formattedText;

    const targetChannel = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!targetChannel) return interaction.editReply('❌ Канал не найден.');

    let mention = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;
    let finalText = text;
    if (mention) {
      finalText = mention + '\n' + text.replace(/^-# [^\n]+\n/, '');
    }
    await sendAnnouncement(targetChannel, finalText, tg.imageUrl);
    await interaction.editReply(
      `✅ Автоанонс опубликован в <#${targetChannel.id}>!` +
      (tg.imageUrl ? '\n🖼 Обложка подтянута из Telegram.' : '\n⚠️ Обложка не найдена.')
    );
  }

  // ── /streamend ───────────────────────────────────────────────────────────────
  if (commandName === 'streamend') {
    const channel = client.channels.cache.get(config.announceChannelId);
    if (!channel) return interaction.reply({ content: '❌ Канал не найден.', ephemeral: true });
    const roleMention = config.streamRoleMention || '@Stream Events';
    await channel.send(
      `-# ${roleMention}\n## ⚫ Стрим завершён\n` +
      `Спасибо всем, кто был с нами! Запись скоро появится на канале. До следующего раза 👋`
    );
    await interaction.reply({ content: '✅ Отправлено.', ephemeral: true });
  }

  // ── /schedule ─────────────────────────────────────────────────────────────────
  if (commandName === 'schedule') {
    const schedule = config.schedule || [];
    if (!schedule.length)
      return interaction.reply({ content: '📅 Расписание пустое.', ephemeral: true });
    const lines = schedule.map((s, i) =>
      `**${i + 1}.** ${s.day} • ${s.time} — **${s.title}**`
    ).join('\n');
    await interaction.reply({ content: `## 📅 Расписание стримов\n${lines}` });
  }
});

client.login(config.token);
