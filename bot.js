const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes, EmbedBuilder
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
    .addStringOption(o => o.setName('image_url')    .setDescription('URL обложки (если не заполнено — берётся из Telegram)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('autoannounce')
    .setDescription('Подтянуть последний анонс стрима из Telegram и опубликовать')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
  console.log(`[TG] Fetching t.me/s/${channelHandle}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}`);
  console.log(`[TG] Got ${html.length} bytes`);

  const postBlocks = [...html.matchAll(
    /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  )].map(m => m[0]);

  console.log(`[TG] Found ${postBlocks.length} post blocks`);

  const streamKeywords = ['стрим', 'стримим', 'прямой эфир', 'stream events', 'подключайся'];
  const streamRegex = new RegExp(streamKeywords.join('|'), 'i');

  let targetPost = null;
  for (let i = postBlocks.length - 1; i >= 0; i--) {
    if (streamRegex.test(postBlocks[i])) {
      targetPost = postBlocks[i];
      break;
    }
  }

  if (!targetPost) throw new Error('Пост про стрим не найден');

  // Картинка — ищем background-image в style
  let imageUrl = null;
  const bgMatch = targetPost.match(/background-image:url\('([^']+)'\)/);
  if (bgMatch) imageUrl = bgMatch[1];
  if (!imageUrl) {
    const imgMatch = targetPost.match(/<img[^>]+src="([^"]+)"/);
    if (imgMatch) imageUrl = imgMatch[1];
  }

  console.log(`[TG] Image URL: ${imageUrl}`);

  const textRaw = targetPost
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").trim();

  const ytMatch = targetPost.match(/href="(https?:\/\/(?:www\.)?youtube[^"]+)"/);
  const vkMatch = targetPost.match(/href="(https?:\/\/(?:www\.)?vkvideo[^"]+|https?:\/\/vk\.com\/video[^"]+)"/);

  return {
    text: textRaw,
    imageUrl: imageUrl || null,
    youtubeUrl: ytMatch ? ytMatch[1] : null,
    vkUrl: vkMatch ? vkMatch[1] : null,
  };
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
    // Embed показывает картинку в полном качестве прямо под текстом
    const embed = new EmbedBuilder().setImage(imageUrl).setColor(0x2B2D31);
    await channel.send({ content: text, embeds: [embed] });
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

    if (!imageUrl) {
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

    const channel = client.channels.cache.get(config.announceChannelId);
    if (!channel) return interaction.editReply('❌ Канал не найден.');

    await sendAnnouncement(channel, text, imageUrl);
    await interaction.editReply(`✅ Анонс опубликован в <#${config.announceChannelId}>!`);
  }

  // ── /autoannounce ─────────────────────────────────────────────────────────────
  if (commandName === 'autoannounce') {
    await interaction.deferReply({ ephemeral: true });

    const tgHandle = (config.telegramChannel || 'https://t.me/animationschool_ru')
      .replace(/^https?:\/\/t\.me\//, '');

    let tg;
    try {
      tg = await fetchTelegramStreamPost(tgHandle);
    } catch (e) {
      return interaction.editReply(`❌ Не удалось распарсить Telegram: ${e.message}`);
    }

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
    const links = [];
    if (youtubeUrl) links.push(`**[YouTube](${youtubeUrl})**`);
    if (tg.vkUrl)   links.push(`**[VK Видео](${tg.vkUrl})**`);

    let text = `-# ${roleMention}\n`;
    text += tg.text;
    if (links.length) text += `\n\n${links.join(' | ')}`;

    const channel = client.channels.cache.get(config.announceChannelId);
    if (!channel) return interaction.editReply('❌ Канал не найден.');

    await sendAnnouncement(channel, text, tg.imageUrl);
    await interaction.editReply(
      `✅ Автоанонс опубликован в <#${config.announceChannelId}>!` +
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
