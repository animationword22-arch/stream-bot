const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes, AttachmentBuilder
} = require('discord.js');
const https = require('https');
const http  = require('http');
const config = require('./challenge_config.json');
config.token = process.env.CHALLENGE_TOKEN || config.token || '';
config.telegramBotToken = process.env.CHALLENGE_TELEGRAM_TOKEN || config.telegramBotToken || '';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const commands = [
  new SlashCommandBuilder()
    .setName('autochallenge')
    .setDescription('Анонс челленджа из Telegram')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('post_id').setDescription('Номер поста в Telegram, напр. 808').setRequired(true))
    .addStringOption(o => o.setName('event_url').setDescription('Ссылка на событие Discord').setRequired(false))
    .addAttachmentOption(o => o.setName('image').setDescription('Обложка (если не загружена — берётся из Telegram)').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Канал публикации').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('autosketching')
    .setDescription('Анонс скетчинга из Telegram')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('topic').setDescription('Тема занятия, напр. «раскадровку»').setRequired(true))
    .addStringOption(o => o.setName('post_id').setDescription('Номер поста в Telegram для обложки').setRequired(false))
    .addStringOption(o => o.setName('time').setDescription('Время по мск, напр. «17:00»').setRequired(false))
    .addStringOption(o => o.setName('event_url').setDescription('Ссылка на событие Discord').setRequired(false))
    .addAttachmentOption(o => o.setName('image').setDescription('Обложка').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Ручной анонс челленджа')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('title').setDescription('Заголовок').setRequired(true))
    .addStringOption(o => o.setName('body').setDescription('Основной текст').setRequired(true))
    .addStringOption(o => o.setName('discord_url').setDescription('Ссылка на событие Discord').setRequired(false))
    .addAttachmentOption(o => o.setName('image').setDescription('Обложка').setRequired(false))
    .addStringOption(o => o.setName('image_url').setDescription('URL обложки').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Тег роли/пользователя').setRequired(false)),

  new SlashCommandBuilder()
    .setName('challengeend')
    .setDescription('Объявить об окончании приёма работ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('Регистрирую команды…');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Команды зарегистрированы ✓');
  } catch (e) { console.error('Ошибка регистрации:', e); }
}

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
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

function parsePostHtml(postHtml) {
  let textRaw = '';
  const msgTextMatch = postHtml.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (msgTextMatch) {
    textRaw = msgTextMatch[1]
      .replace(/<br[^>]*>/gi, '\n')
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
  const photoMatch = postHtml.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoMatch) imageUrl = photoMatch[1];
  if (!imageUrl) {
    const bgMatches = [...postHtml.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) { imageUrl = m[1]; break; }
    }
  }

  const discordMatch = postHtml.match(/href="(https?:\/\/discord\.(?:gg|com)[^"]+)"/);
  return { text: textRaw, imageUrl: imageUrl || null, discordUrl: discordMatch ? discordMatch[1] : null };
}

async function fetchTelegramPostById(channelHandle, postId) {
  console.log(`[TG] Fetching post ${postId}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}?before=${parseInt(postId) + 1}`);
  const postBlocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
  const target = postBlocks.find(p => p.includes(`/${channelHandle}/${postId}`)) || postBlocks[postBlocks.length - 1];
  if (!target) throw new Error('Пост не найден');
  return parsePostHtml(target);
}

async function fetchTelegramPost(channelHandle, keywords) {
  console.log(`[TG] Fetching latest post from ${channelHandle}...`);
  const html = await fetchUrl(`https://t.me/s/${channelHandle}`);
  const postBlocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
  const regex = new RegExp(keywords.join('|'), 'i');
  let target = null;
  for (let i = postBlocks.length - 1; i >= 0; i--) {
    if (regex.test(postBlocks[i])) { target = postBlocks[i]; break; }
  }
  if (!target) throw new Error('Пост не найден');
  return parsePostHtml(target);
}

// ─── Telegram Bot API ────────────────────────────────────────────────────────
// Получаем пост из Telegram канала через t.me/s/
async function fetchTelegramPostByAPI(channelUsername, postId) {
  console.log(`[TG] Fetching post ${postId} from ${channelUsername}...`);
  
  // Пробуем разные значения before начиная с postId+1
  let target = null;
  const pid = parseInt(postId);
  
  for (let offset = 1; offset <= 50; offset++) {
    const before = pid + offset;
    const html = await fetchUrl(`https://t.me/s/${channelUsername}?before=${before}`);
    const blocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
    
    target = blocks.find(b => {
      const m = b.match(/data-post="([^"]+)"/);
      return m && m[1] === `${channelUsername}/${postId}`;
    });
    
    if (target) { console.log(`[TG] Found at before=${before}`); break; }
    if (offset % 10 === 0) console.log(`[TG] Trying before=${before}...`);
  }
  
  if (!target) throw new Error(`Пост ${postId} не найден`);

  // Текст
  const allTexts = [...target.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(m => m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
      .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    ).filter(Boolean);
  let text = allTexts.length ? allTexts.reduce((a, b) => a.length >= b.length ? a : b, '') : '';
  // Заменяем discord.gg ссылки на упоминание канала
  if (config.challengeWorkChannelId) {
    text = text.replace(/\[([^\]]+)\]\(https?:\/\/discord\.gg\/[^\)]+\)/g, `<#${config.challengeWorkChannelId}>`);
    text = text.replace(/https?:\/\/discord\.gg\/\S+/g, `<#${config.challengeWorkChannelId}>`);
  }

  // Картинка
  let imageUrl = null;
  const photoMatch = target.match(/tgme_widget_message_photo_wrap[^>]+style="[^"]*background-image:url\('([^']+)'\)/);
  if (photoMatch) imageUrl = photoMatch[1];
  if (!imageUrl) {
    const bgMatches = [...target.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)];
    for (const m of bgMatches) {
      if (!m[1].includes('youtube') && !m[1].includes('vk.com')) { imageUrl = m[1]; break; }
    }
  }

  return { text, imageUrl };
}

function buildChallengeText({ title, time, theme, deadline, postUrl, workChannelId, discordUrl, mention, roleMention }) {
  const t = time || '19:00';
  const workChannel = workChannelId ? `<#${workChannelId}>` : '#animation-challenge-chat';
  const postLink = postUrl ? `[постом](${postUrl})` : 'постом';

  let text = '';
  if (mention) text += `-# ${mention}\n`;
  else if (roleMention) text += `-# ${roleMention}\n`;

  text += `# ${title}\n`;
  text += `## Присоединяйтесь к нам сегодня в ${t} по мск.\n`;
  if (deadline) {
    text += `\nСделайте анимацию на основе предоставленной нами темой. Разрешены любые стили и средства, разрешены любые ваши идеи! Присылайте свои работы в ${workChannel}, либо в комментариях под этим ${postLink} до ${deadline}!`;
  } else {
    text += `\nСделайте анимацию на основе предоставленной нами темой. Разрешены любые стили и средства, разрешены любые ваши идеи!`;
  }
  if (discordUrl) text += `\n\n-# *Не забудьте подписаться на событие в Discord, чтобы вовремя получить оповещение о начале челленджа!*\n-# ${discordUrl}`;
  return text.trim();
}

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
  if (discordUrl) text += `\n\n-# *Не забудьте подписаться на событие в Discord, чтобы вовремя получить оповещение о начале челленджа!*\n-# ${discordUrl}`;
  return text.trim();
}

async function sendAnnouncement(channel, text, imageUrl) {
  if (!imageUrl) { await channel.send({ content: text }); return; }
  try {
    // Всегда скачиваем буфер — так надёжнее для всех источников
    const buffer = await fetchImageBuffer(imageUrl);
    await channel.send({ content: text, files: [new AttachmentBuilder(buffer, { name: 'cover.jpg' })] });
  } catch (e) {
    console.warn('[IMG] Ошибка:', e.message);
    await channel.send({ content: text });
  }
}

client.once('ready', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'autochallenge') {
    await interaction.deferReply({ ephemeral: true });

    const postId   = interaction.options.getString('post_id') || '';
    const eventUrl = interaction.options.getString('event_url') || '';
    const attached = interaction.options.getAttachment('image');
    let   mention  = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');

    // Получаем пост через Bot API
    let tg = { text: '', imageUrl: null };
    try {
      tg = await fetchTelegramPostByAPI(tgHandle, postId);
    } catch (e) {
      console.warn('[TG Bot API]:', e.message);
      return interaction.editReply(`❌ Не удалось получить пост: ${e.message}`);
    }

    // Если прикреплена картинка — используем её
    if (attached) tg.imageUrl = attached.url;

    // Убираем блок "Подключайся к нашему голосовому каналу" из текста
    let cleanText = tg.text
      .replace(/Подключайся к нашему голосовому каналу[\s\S]*$/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Первая строка — заголовок #
    const textLines = cleanText.split('\n');
    let firstLine = true;
    cleanText = textLines.map(l => {
      if (firstLine && l.trim()) { firstLine = false; return `# ${l.trim()}`; }
      return l;
    }).join('\n');

    // Добавляем тег роли
    const roleMention = mention || config.challengeRoleMention || '';
    // Убираем пустые markdown маркеры
    cleanText = cleanText
      .replace(/[*]{2}\s*[*]{2}/g, '')
      .replace(/[*]\s*[*]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    let text = roleMention ? `-# ${roleMention}\n` : '';
    text += cleanText;

    // Добавляем блок Discord события если указан
    if (eventUrl) {
      text += `\n\n-# *Не забудьте подписаться на событие в Discord, чтобы вовремя получить оповещение о начале челленджа!*\n-# ${eventUrl}`;
    }

    const ch = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!ch) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(ch, text, tg.imageUrl);
    await interaction.editReply(`✅ Опубликовано в <#${ch.id}>!`);
  }

  if (commandName === 'autosketching') {
    await interaction.deferReply({ ephemeral: true });
    const topic    = interaction.options.getString('topic');
    const time     = interaction.options.getString('time') || '17:00';
    const eventUrl = interaction.options.getString('event_url') || '';
    const postId   = interaction.options.getString('post_id') || '';
    const attached = interaction.options.getAttachment('image');
    let mention    = interaction.options.getString('mention') || '';
    if (mention && /^\d+$/.test(mention.trim())) mention = `<@&${mention.trim()}>`;

    let imageUrl = attached ? attached.url : null;
    if (!imageUrl) {
      try {
        const tgHandle = config.telegramChannel.replace(/^https?:\/\/t\.me\//, '');
        const tg = postId
          ? await fetchTelegramPostById(tgHandle, postId)
          : await fetchTelegramPost(tgHandle, ['скетчинг', 'sketching', 'персонаж', 'рисовать', 'наброски', 'live sketching']);
        if (tg.imageUrl) imageUrl = tg.imageUrl;
      } catch (e) { console.warn('[TG] Обложка не найдена:', e.message); }
    }

    // Если в тексте поста есть discord.gg ссылка — заменяем на канал скетчинга
    if (tg && tg.text && config.sketchingChannelId) {
      tg.text = tg.text
        .replace(/\[([^\]]+)\]\(https?:\/\/discord\.gg\/[^\)]+\)/g, `<#${config.sketchingChannelId}>`)
        .replace(/https?:\/\/discord\.gg\/\S+/g, `<#${config.sketchingChannelId}>`);
    }

    const text = buildSketchingText({
      topic, time,
      discordUrl: eventUrl || config.sketchingEventUrl || '',
      sketchChannelId: config.sketchingChannelId || '',
      telegramUrl: config.telegramChannel || 'https://t.me/animationclub_challange',
      mention, roleMention: mention ? null : (config.sketchingRoleMention || config.challengeRoleMention || null)
    });

    const ch = interaction.options.getChannel('channel') || client.channels.cache.get(config.sketchingAnnounceChannelId || config.announceChannelId);
    if (!ch) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(ch, text, imageUrl);
    await interaction.editReply(`✅ Опубликовано в <#${ch.id}>!`);
  }

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
    const text = buildChallengeText({ title, body, discordUrl, mention, roleMention: mention ? null : (config.challengeRoleMention || null) });
    const ch = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!ch) return interaction.editReply('❌ Канал не найден.');
    await sendAnnouncement(ch, text, imageUrl);
    await interaction.editReply(`✅ Опубликовано в <#${ch.id}>!`);
  }

  if (commandName === 'challengeend') {
    const ch = interaction.options.getChannel('channel') || client.channels.cache.get(config.announceChannelId);
    if (!ch) return interaction.reply({ content: '❌ Канал не найден.', ephemeral: true });
    const role = config.challengeRoleMention || '';
    await ch.send((role ? `-# ${role}\n` : '') + `## ⏰ Приём работ завершён!\nСпасибо всем участникам — ждём ваши анимации! Результаты объявим совсем скоро 🎉`);
    await interaction.reply({ content: '✅ Отправлено.', ephemeral: true });
  }
});

client.login(config.token);
